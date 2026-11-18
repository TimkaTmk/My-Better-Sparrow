use crate::collision_detection::CDEConfig;
use crate::entities::Container;
use crate::geometry::primitives::{Point, Rect, SPolygon};
use crate::geometry::shape_modification::{ShapeModifyConfig, ShapeModifyMode};
use crate::geometry::{DTransformation, OriginalShape};
use anyhow::{Result, ensure};
use std::sync::Arc;

#[derive(Clone, Debug, PartialEq)]
/// Represents a fixed-height strip with a variable right edge and optional fixed left profile.
pub struct Strip {
    pub fixed_height: f32,
    pub cde_config: CDEConfig,
    pub shape_modify_config: ShapeModifyConfig,
    pub width: f32,
    /// Open left contour, ordered from y=0 to y=fixed_height. `None` is rectangular.
    pub left_boundary: Option<Arc<[Point]>>,
}

impl Strip {
    pub fn new(
        fixed_height: f32,
        cde_config: CDEConfig,
        shape_modify_config: ShapeModifyConfig,
        width: f32,
        left_boundary: Option<Vec<Point>>,
    ) -> Result<Self> {
        ensure!(fixed_height > 0.0, "strip height must be positive");
        ensure!(width > 0.0, "strip width must be positive");
        if let Some(points) = &left_boundary {
            ensure!(
                (2..=5000).contains(&points.len()),
                "strip left boundary needs 2–5,000 points"
            );
            ensure!(
                points.iter().all(|p| p.0.is_finite()
                    && p.1.is_finite()
                    && p.0 >= 0.0
                    && p.0 <= 100_000.0
                    && p.1 >= 0.0
                    && p.1 <= 100_000.0),
                "strip left boundary coordinates must be finite and within 100,000 units"
            );
            ensure!(
                points[0].1.abs() <= 1e-5
                    && (points.last().unwrap().1 - fixed_height).abs() <= 1e-5,
                "strip left boundary must run from y=0 to the fixed strip height"
            );
            ensure!(
                points.iter().all(|p| p.1 <= fixed_height),
                "strip left boundary must stay inside the strip height"
            );
            ensure!(
                points.windows(2).all(|pair| pair[0] != pair[1]),
                "strip left boundary contains a zero-length edge"
            );
            ensure!(
                width > points.iter().map(|p| p.0).fold(0.0_f32, f32::max),
                "strip right edge must be right of the left boundary"
            );
        }
        Ok(Strip {
            fixed_height,
            cde_config,
            shape_modify_config,
            width,
            left_boundary: left_boundary.map(Arc::from),
        })
    }

    pub fn set_width(&mut self, width: f32) {
        assert!(width > 0.0, "strip width must be positive");
        self.width = width;
    }

    /// A safe minimum right-edge coordinate for the fixed-profile polygon.
    #[must_use]
    pub fn minimum_width(&self) -> f32 {
        self.left_boundary.as_ref().map_or(0.0, |points| {
            let rightmost = points.iter().map(|p| p.0).fold(0.0_f32, f32::max);
            rightmost
                + self.fixed_height.max(rightmost).max(1.0) * SPolygon::MIN_EDGE_LENGTH_RATIO * 2.0
        })
    }
}

impl TryFrom<Strip> for Container {
    type Error = anyhow::Error;

    fn try_from(s: Strip) -> Result<Container> {
        let shape = if let Some(profile) = s.left_boundary.as_ref() {
            let mut left_boundary = profile.to_vec();
            let max_x = left_boundary.iter().map(|p| p.0).fold(0.0_f32, f32::max);
            ensure!(
                s.width > max_x,
                "strip right edge intersects its left boundary"
            );
            left_boundary.push((s.width, s.fixed_height).into());
            left_boundary.push((s.width, 0.0).into());
            SPolygon::new(left_boundary)?
        } else {
            SPolygon::try_from(Rect::try_new(0.0, 0.0, s.width, s.fixed_height)?)?
        };
        Container::new(
            OriginalShape {
                shape,
                pre_transform: DTransformation::empty(),
                modify_mode: ShapeModifyMode::Deflate,
                modify_config: s.shape_modify_config,
            },
            vec![],
            s.cde_config,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::collision_detection::CDEConfig;
    use crate::geometry::fail_fast::SPSurrogateConfig;
    use crate::geometry::geo_traits::CollidesWith;
    use crate::probs::spp::entities::{SPInstance, SPProblem};

    fn cde_config() -> CDEConfig {
        CDEConfig {
            item_surrogate_config: SPSurrogateConfig {
                n_pole_limits: [(100, 0.0), (20, 0.75), (10, 0.90)],
                ff_pole_area_ratio: 0.5,
            },
        }
    }

    #[test]
    fn changing_strip_width_keeps_its_non_rectangular_left_edge() {
        let profile = vec![(0.0, 0.0).into(), (5.0, 5.0).into(), (0.0, 10.0).into()];
        let strip = Strip::new(
            10.0,
            cde_config(),
            ShapeModifyConfig::default(),
            20.0,
            Some(profile.clone()),
        )
        .unwrap();
        let mut problem = SPProblem::new(SPInstance::new(vec![], strip)).unwrap();
        let before = problem.layout().container().outer_cd().clone();
        assert!(!before.collides_with(&Point(2.0, 5.0)));
        assert!(before.collides_with(&Point(10.0, 5.0)));

        problem.change_strip_width(30.0).unwrap();
        let container = problem.layout().container().outer_cd();
        assert_eq!(
            problem.strip().left_boundary.as_ref().unwrap().as_ref(),
            profile.as_slice()
        );
        assert_eq!(container.bbox().x_max, 30.0);
        assert!(!container.collides_with(&Point(2.0, 5.0)));
        assert!(container.collides_with(&Point(10.0, 5.0)));
        assert!(
            problem
                .change_strip_width(problem.strip().minimum_width() - 0.01)
                .is_err()
        );
    }
}
