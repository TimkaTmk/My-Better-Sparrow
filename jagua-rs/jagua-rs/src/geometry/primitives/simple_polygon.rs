use itertools::Itertools;
use ordered_float::{NotNan, OrderedFloat};

use crate::geometry::Transformation;
use crate::geometry::convex_hull::convex_hull_from_points;
use crate::geometry::fail_fast::{SPSurrogate, SPSurrogateConfig, compute_pole};
use crate::geometry::geo_enums::GeoPosition;
use crate::geometry::geo_traits::{
    CollidesWith, DistanceTo, SeparationDistance, Transformable, TransformableFrom,
};
use crate::geometry::primitives::Circle;
use crate::geometry::primitives::Edge;
use crate::geometry::primitives::GeometryError;
use crate::geometry::primitives::Point;
use crate::geometry::primitives::Rect;
use crate::geometry::short_edges::remove_short_edges;
use crate::util::FPA;
use crate::util::assertions;
use anyhow::{Result, bail, ensure};
use geo::Intersects;
use log::debug;

/// A polygon with a simple exterior ring and optional simple hole rings.
/// Vertex and edge indices always refer to the exterior ring.
#[derive(Clone, Debug)]
pub struct SPolygon {
    /// Vertices in counterclockwise order, including after reflection.
    pub(crate) vertices: Vec<Point>,
    holes: Box<[SPolygon]>,
    /// Bounding box
    pub(crate) bbox: Rect,
    /// Area enclosed by the exterior ring
    pub(crate) area: f32,
    /// Maximum distance between any two points in the polygon
    pub(crate) diameter: f32,
    /// [Pole of inaccessibility](https://en.wikipedia.org/wiki/Pole_of_inaccessibility) represented as a circle
    pub(crate) poi: Circle,
    /// Optional surrogate representation of the polygon (subset of the original)
    pub(crate) surrogate: Option<SPSurrogate>,
}

impl SPolygon {
    /// Minimum length of an edge, as a fraction of the polygon's diameter.
    ///
    /// Shorter edges are removed on construction, see [`SPolygon::new`].
    /// The margin is large compared to the `f32` rounding error of the coordinates of a centered polygon
    /// (about `6e-8` times the diameter), so centering or rotating it cannot collapse an edge into a single point (issue #133).
    ///
    /// [`Transformable::transform`] and [`TransformableFrom::transform_from`] do not uphold this minimum:
    /// translated far from the origin, where the `f32` spacing exceeds it, a short edge can still collapse.
    /// Collision detection does not rely on the minimum; rebuild the polygon with [`SPolygon::new`] where it is needed.
    pub const MIN_EDGE_LENGTH_RATIO: f32 = 1e-5;

    /// Create a new simple polygon from a set of points, expensive operations are performed here! Use [`Self::clone()`] or [`Self::transform()`] to avoid recomputation.
    ///
    /// Every vertex that lies closer than [`SPolygon::MIN_EDGE_LENGTH_RATIO`] times the diameter
    /// to the previous kept vertex is removed, so no edge is shorter than that.
    /// Returns an error if the remaining vertices do not form a valid simple polygon.
    pub fn new(mut points: Vec<Point>) -> Result<Self> {
        ensure!(
            points.iter().all(|p| p.0.is_finite() && p.1.is_finite()),
            "polygon coordinates must be finite"
        );
        if points.len() < 3 {
            bail!(GeometryError::TooFewPoints(points.len()));
        }
        let removal = remove_short_edges(&mut points);
        if !removal.removed.is_empty() {
            debug!("[SP] {removal}");
        }
        if points.len() < 3 {
            bail!(GeometryError::TooFewPoints(points.len()));
        }
        if points.iter().unique().count() != points.len() {
            let [i, j] = (0..points.len())
                .array_combinations()
                .find(|&[i, j]| points[i] == points[j])
                .expect("a duplicate point exists");
            bail!(GeometryError::DuplicatePoints(i, j));
        }
        if let Some((e1_idx, e2_idx)) = SPolygon::find_self_intersection(&points) {
            bail!(GeometryError::IntersectingEdges(e1_idx, e2_idx));
        }

        let area = match SPolygon::calculate_area(&points) {
            0.0 => bail!(GeometryError::NoArea),
            area if area < 0.0 => {
                //edges should always be ordered counterclockwise (positive area)
                points.reverse();
                -area
            }
            area => area,
        };

        let diameter = SPolygon::calculate_diameter(points.clone());
        let bbox = SPolygon::generate_bounding_box(&points);
        let poi = SPolygon::calculate_poi(&points, diameter)?;

        Ok(SPolygon {
            vertices: points,
            holes: Box::default(),
            bbox,
            area,
            diameter,
            poi,
            surrogate: None,
        })
    }

    /// Adds strictly interior, disjoint holes to a simple polygon.
    pub fn with_holes(mut self, holes: Vec<Self>) -> Result<Self> {
        ensure!(self.holes.is_empty(), "exterior ring must be simple");
        for (i, hole) in holes.iter().enumerate() {
            ensure!(
                hole.holes.is_empty(),
                "hole {} must be a simple ring",
                i + 1
            );
            ensure!(
                self.contains_ring_point(&hole.vertex(0)) && !rings_touch(&self, hole),
                "hole {} must lie strictly inside its exterior ring",
                i + 1
            );
            for other in &holes[..i] {
                ensure!(
                    !rings_touch(hole, other)
                        && !hole.contains_ring_point(&other.vertex(0))
                        && !other.contains_ring_point(&hole.vertex(0)),
                    "hole {} intersects or contains another hole",
                    i + 1
                );
            }
        }
        if !holes.is_empty() {
            self.holes = holes.into_boxed_slice();
            ensure!(
                self.area() > 0.0,
                "polygon must contain a positive area of material"
            );
            self.poi = compute_pole(&self, &[])?;
            self.surrogate = None;
        }
        Ok(self)
    }

    /// The disjoint simple rings that bound the holes.
    #[must_use]
    pub fn holes(&self) -> &[Self] {
        &self.holes
    }

    pub(crate) fn rings(&self) -> impl Iterator<Item = &Self> {
        std::iter::once(self).chain(&self.holes)
    }

    /// Point membership for ring-aware collision tests after checking boundary contact.
    pub(crate) fn contains_material_point(&self, point: &Point) -> bool {
        self.contains_ring_point(point) && !self.holes.iter().any(|h| h.contains_ring_point(point))
    }

    fn contains_ring_point(&self, point: &Point) -> bool {
        if !self.bbox.collides_with(point) {
            return false;
        }
        let (x, y) = (f64::from(point.0), f64::from(point.1));
        self.edge_iter()
            .filter(|edge| {
                let (ax, ay) = (f64::from(edge.start.0), f64::from(edge.start.1));
                let (bx, by) = (f64::from(edge.end.0), f64::from(edge.end.1));
                (ay > y) != (by > y) && x < ax + (bx - ax) * (y - ay) / (by - ay)
            })
            .count()
            % 2
            == 1
    }

    pub fn generate_surrogate(&mut self, config: SPSurrogateConfig) -> Result<()> {
        //regenerate the surrogate if it is not present or if the config has changed
        match &self.surrogate {
            Some(surrogate) if surrogate.config == config => {}
            _ => self.surrogate = Some(SPSurrogate::new(self, config)?),
        }
        Ok(())
    }

    #[must_use]
    pub fn vertex(&self, i: usize) -> Point {
        self.vertices[i]
    }

    #[must_use]
    pub fn edge(&self, i: usize) -> Edge {
        assert!(i < self.n_vertices(), "index out of bounds");
        let j = if i == self.n_vertices() - 1 { 0 } else { i + 1 };
        Edge {
            start: self.vertices[i],
            end: self.vertices[j],
        }
    }

    pub fn edge_iter(&self) -> impl Iterator<Item = Edge> + '_ {
        (0..self.n_vertices()).map(move |i| self.edge(i))
    }

    #[must_use]
    pub fn n_vertices(&self) -> usize {
        self.vertices.len()
    }

    #[must_use]
    pub fn surrogate(&self) -> &SPSurrogate {
        self.surrogate.as_ref().expect("surrogate not generated")
    }

    #[must_use]
    pub(crate) fn calculate_diameter(points: Vec<Point>) -> f32 {
        //The two points furthest apart must be part of the convex hull
        let ch = convex_hull_from_points(points);

        //go through all pairs of points and find the pair with the largest distance
        let sq_diam = ch
            .iter()
            .array_combinations::<2>()
            .map(|[p1, p2]| p1.sq_distance_to(p2))
            .max_by_key(|sq_d| NotNan::new(*sq_d).unwrap())
            .unwrap_or(0.0); // fewer than two distinct points

        sq_diam.sqrt()
    }

    #[must_use]
    pub fn generate_bounding_box(points: &[Point]) -> Rect {
        let (mut x_min, mut y_min) = (f32::MAX, f32::MAX);
        let (mut x_max, mut y_max) = (f32::MIN, f32::MIN);

        for point in points {
            x_min = x_min.min(point.0);
            y_min = y_min.min(point.1);
            x_max = x_max.max(point.0);
            y_max = y_max.max(point.1);
        }
        Rect::try_new(x_min, y_min, x_max, y_max).unwrap()
    }

    //https://en.wikipedia.org/wiki/Shoelace_formula
    //counterclockwise = positive area, clockwise = negative area
    #[must_use]
    pub fn calculate_area(points: &[Point]) -> f32 {
        let mut sigma: f32 = 0.0;
        for i in 0..points.len() {
            //next point
            let j = (i + 1) % points.len();

            let (x_i, y_i) = points[i].into();
            let (x_j, y_j) = points[j].into();

            sigma += (y_i + y_j) * (x_i - x_j);
        }

        0.5 * sigma
    }

    fn calculate_poi(points: &[Point], diameter: f32) -> Result<Circle> {
        //need to make a dummy simple polygon, because the pole generation algorithm
        //relies on many of the methods provided by the simple polygon struct
        let dummy_sp = {
            let bbox = SPolygon::generate_bounding_box(points);
            let area = SPolygon::calculate_area(points);
            let dummy_poi = Circle::try_new(Point(f32::MAX, f32::MAX), f32::MAX).unwrap();

            SPolygon {
                vertices: points.to_vec(),
                holes: Box::default(),
                bbox,
                area,
                diameter,
                poi: dummy_poi,
                surrogate: None,
            }
        };

        compute_pole(&dummy_sp, &[])
    }

    #[must_use]
    pub fn centroid(&self) -> Point {
        //based on: https://en.wikipedia.org/wiki/Centroid#Of_a_polygon

        //relative to the first vertex: far from the origin, the cross products of absolute coordinates cancel out
        let Point(o_x, o_y) = self.vertex(0);
        let area = self.area;
        let mut c_x = 0.0;
        let mut c_y = 0.0;

        for i in 0..self.n_vertices() {
            let j = if i == self.n_vertices() - 1 { 0 } else { i + 1 };
            let (x_i, y_i) = (self.vertex(i).0 - o_x, self.vertex(i).1 - o_y);
            let (x_j, y_j) = (self.vertex(j).0 - o_x, self.vertex(j).1 - o_y);
            c_x += (x_i + x_j) * (x_i * y_j - x_j * y_i);
            c_y += (y_i + y_j) * (x_i * y_j - x_j * y_i);
        }

        c_x /= 6.0 * area;
        c_y /= 6.0 * area;

        (o_x + c_x, o_y + c_y).into()
    }

    fn find_self_intersection(points: &[Point]) -> Option<(usize, usize)> {
        let edge = |i| Edge {
            start: points[i],
            end: points[(i + 1) % points.len()],
        };
        let are_neighboring_edges = |i, j| i + 1 == j || (i == 0 && j == points.len() - 1);

        (0..points.len()).combinations(2).find_map(|pair| {
            let (i, j) = (pair[0], pair[1]);
            (!are_neighboring_edges(i, j) && edge(i).collides_with(&edge(j))).then_some((i, j))
        })
    }

    /// Vertices in counterclockwise order, including after reflection.
    #[must_use]
    pub fn vertices(&self) -> &[Point] {
        &self.vertices
    }

    /// Bounding box
    #[must_use]
    pub fn bbox(&self) -> Rect {
        self.bbox
    }

    /// Area of the material, excluding holes.
    #[must_use]
    pub fn area(&self) -> f32 {
        (f64::from(self.area) - self.holes.iter().map(|h| f64::from(h.area)).sum::<f64>()) as f32
    }

    /// Maximum distance between any two points in the polygon
    #[must_use]
    pub fn diameter(&self) -> f32 {
        self.diameter
    }

    /// [Pole of inaccessibility](https://en.wikipedia.org/wiki/Pole_of_inaccessibility) represented as a circle
    #[must_use]
    pub fn poi(&self) -> Circle {
        self.poi
    }
}

impl Transformable for SPolygon {
    fn transform(&mut self, t: &Transformation) -> &mut Self {
        let reflected = t.is_reflected();
        //destructuring pattern to ensure that the code is updated when the struct changes
        let SPolygon {
            vertices: points,
            holes,
            bbox,
            area: _,
            diameter: _,
            poi,
            surrogate,
        } = self;

        //transform all points of the simple poly
        for p in points.iter_mut() {
            p.transform(t);
        }
        if reflected {
            points.reverse();
        }
        for hole in holes {
            hole.transform(t);
        }

        poi.transform(t);

        //transform the surrogate
        if let Some(surrogate) = surrogate.as_mut() {
            surrogate.transform(t);
            if reflected {
                surrogate.reverse_vertex_order(points.len());
            }
        }

        //regenerate bounding box
        *bbox = SPolygon::generate_bounding_box(points);

        self
    }
}

impl TransformableFrom for SPolygon {
    fn transform_from(&mut self, reference: &Self, t: &Transformation) -> &mut Self {
        let reflected = t.is_reflected();
        assert_eq!(self.vertices.len(), reference.vertices.len());
        assert_eq!(self.holes.len(), reference.holes.len());
        //destructuring pattern to ensure that the code is updated when the struct changes
        let SPolygon {
            vertices: points,
            holes,
            bbox,
            area: _,
            diameter: _,
            poi,
            surrogate,
        } = self;

        if reflected {
            for (p, ref_p) in points.iter_mut().zip(reference.vertices.iter().rev()) {
                p.transform_from(ref_p, t);
            }
        } else {
            for (p, ref_p) in points.iter_mut().zip(&reference.vertices) {
                p.transform_from(ref_p, t);
            }
        }
        for (hole, source) in holes.iter_mut().zip(&reference.holes) {
            hole.transform_from(source, t);
        }

        poi.transform_from(&reference.poi, t);

        //transform the surrogate
        if let Some(surrogate) = surrogate.as_mut() {
            let ref_surrogate = reference.surrogate();
            surrogate.transform_from(ref_surrogate, t);
            // The destination was cloned from `reference`, so its hull indices only
            // need remapping when the vertex storage orientation changes.
            if surrogate.hull_reversed() != (ref_surrogate.hull_reversed() ^ reflected) {
                surrogate.reverse_vertex_order(points.len());
            }
            debug_assert!(assertions::hull_indices_match_reference(
                surrogate,
                ref_surrogate,
                reflected,
                points.len()
            ));
        }
        //regenerate bounding box
        *bbox = SPolygon::generate_bounding_box(points);

        self
    }
}

impl CollidesWith<Point> for SPolygon {
    fn collides_with(&self, point: &Point) -> bool {
        if !self.holes.is_empty() {
            return self.contains_material_point(point);
        }
        //based on the ray casting algorithm: https://en.wikipedia.org/wiki/Point_in_polygon#Ray_casting_algorithm
        if self.bbox.collides_with(point) {
            //horizontal ray shot to the right.
            //Starting from the point to another point that is certainly outside the shape
            let point_outside = Point(self.bbox.x_max + self.bbox.width(), point.1);
            let ray = Edge {
                start: *point,
                end: point_outside,
            };

            let n_intersections = self
                .edge_iter()
                .filter(|edge| ray_crosses(edge, point, &ray))
                .count();
            n_intersections % 2 == 1
        } else {
            false
        }
    }
}

pub(crate) fn edges_touch(a: &Edge, b: &Edge) -> bool {
    fn as_line(edge: &Edge) -> geo::Line<f64> {
        let coord = |p: Point| (f64::from(p.0), f64::from(p.1));
        geo::Line::new(coord(edge.start), coord(edge.end))
    }
    a.bbox().collides_with(&b.bbox()) && as_line(a).intersects(&as_line(b))
}

fn rings_touch(a: &SPolygon, b: &SPolygon) -> bool {
    a.bbox.collides_with(&b.bbox)
        && a.edge_iter()
            .any(|a| b.edge_iter().any(|b| edges_touch(&a, &b)))
}

/// Whether `edge` counts as a crossing of `ray`, shot horizontally to the right from `point`,
/// in the ray casting test of [`SPolygon::collides_with`].
#[inline(always)]
pub(crate) fn ray_crosses(edge: &Edge, point: &Point, ray: &Edge) -> bool {
    //Check if the ray does not go through (or almost through) a vertex
    //This can result in funky behaviour, which could incorrect results
    //Therefore we handle this case
    let (s_x, s_y) = (FPA(edge.start.0), FPA(edge.start.1));
    let (e_x, e_y) = (FPA(edge.end.0), FPA(edge.end.1));
    let (p_x, p_y) = (FPA(point.0), FPA(point.1));

    if (s_y == p_y && s_x > p_x) || (e_y == p_y && e_x > p_x) {
        //in this case, the ray passes through (or dangerously close to) a vertex
        //We handle this case by only counting an intersection if the edge is below the ray
        s_y < p_y || e_y < p_y
    } else {
        ray.collides_with(edge)
    }
}

impl DistanceTo<Point> for SPolygon {
    fn distance_to(&self, point: &Point) -> f32 {
        self.sq_distance_to(point).sqrt()
    }
    fn sq_distance_to(&self, point: &Point) -> f32 {
        if self.collides_with(point) {
            0.0
        } else {
            self.rings()
                .flat_map(Self::edge_iter)
                .map(|edge| edge.sq_distance_to(point))
                .min_by(|a, b| a.partial_cmp(b).unwrap())
                .unwrap()
        }
    }
}

impl SeparationDistance<Point> for SPolygon {
    fn separation_distance(&self, point: &Point) -> (GeoPosition, f32) {
        let (position, sq_distance) = self.sq_separation_distance(point);
        (position, sq_distance.sqrt())
    }

    fn sq_separation_distance(&self, point: &Point) -> (GeoPosition, f32) {
        let distance_to_closest_edge = self
            .rings()
            .flat_map(Self::edge_iter)
            .map(|edge| edge.sq_distance_to(point))
            .min_by_key(|sq_d| OrderedFloat(*sq_d))
            .unwrap();

        if self.collides_with(point) {
            (GeoPosition::Interior, distance_to_closest_edge)
        } else {
            (GeoPosition::Exterior, distance_to_closest_edge)
        }
    }
}

impl TryFrom<&Rect> for SPolygon {
    type Error = anyhow::Error;

    /// Fails if the rectangle is so thin that [`SPolygon::new`] removes its short sides,
    /// see [`SPolygon::MIN_EDGE_LENGTH_RATIO`].
    fn try_from(r: &Rect) -> Result<Self> {
        SPolygon::new(vec![
            (r.x_min, r.y_min).into(),
            (r.x_max, r.y_min).into(),
            (r.x_max, r.y_max).into(),
            (r.x_min, r.y_max).into(),
        ])
    }
}

impl TryFrom<Rect> for SPolygon {
    type Error = anyhow::Error;

    /// See [`SPolygon::try_from(&Rect)`](#impl-TryFrom%3C%26Rect%3E-for-SPolygon).
    fn try_from(r: Rect) -> Result<Self> {
        SPolygon::try_from(&r)
    }
}
