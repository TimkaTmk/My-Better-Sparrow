import { orient2d } from 'robust-predicates';
import { LIMITS, type Document, type Point, type Ring, type Part, type Placement } from '../model';

export const area = (ring: Ring) => ring.reduce((sum, p, i) => {
  const q = ring[(i + 1) % ring.length]; return sum + p[0] * q[1] - q[0] * p[1];
}, 0) / 2;
export const bounds = (ring: Ring) => ring.reduce((b, p) => [Math.min(b[0], p[0]), Math.min(b[1], p[1]), Math.max(b[2], p[0]), Math.max(b[3], p[1])], [Infinity, Infinity, -Infinity, -Infinity]);
export const same = (a: Point, b: Point) => a[0] === b[0] && a[1] === b[1];
const orient = (a: Point, b: Point, c: Point) => orient2d(...a, ...b, ...c);
const on = (a: Point, b: Point, p: Point) => orient(a,b,p) === 0 && p[0] >= Math.min(a[0],b[0]) && p[0] <= Math.max(a[0],b[0]) && p[1] >= Math.min(a[1],b[1]) && p[1] <= Math.max(a[1],b[1]);
export function intersects(a: Point, b: Point, c: Point, d: Point) {
  // Strict separation only: touching boxes still reach the robust orientation tests.
  if(Math.max(a[0],b[0])<Math.min(c[0],d[0]) || Math.max(c[0],d[0])<Math.min(a[0],b[0])
    || Math.max(a[1],b[1])<Math.min(c[1],d[1]) || Math.max(c[1],d[1])<Math.min(a[1],b[1]))return false;
  const x = orient(a,b,c), y = orient(a,b,d), z = orient(c,d,a), w = orient(c,d,b);
  return (Math.sign(x) !== Math.sign(y) && x !== 0 && y !== 0 && Math.sign(z) !== Math.sign(w) && z !== 0 && w !== 0) || on(a,b,c) || on(a,b,d) || on(c,d,a) || on(c,d,b);
}
export function inside(p: Point, ring: Ring): boolean {
  let result = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if (on(a,b,p)) return false;
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0]-a[0]) * (p[1]-a[1]) / (b[1]-a[1]) + a[0]) result = !result;
  }
  return result;
}
export function ringCrosses(a: Ring, b: Ring) {
  const aa = bounds(a), bb = bounds(b);
  if (aa[2] < bb[0] || bb[2] < aa[0] || aa[3] < bb[1] || bb[3] < aa[1]) return false;
  return a.some((p,i) => b.some((q,j) => intersects(p,a[(i+1)%a.length],q,b[(j+1)%b.length])));
}
export function normalizeRing(value: unknown): Ring {
  if (!Array.isArray(value) || value.length > LIMITS.verticesPerPart + 1) throw Error('Contour exceeds 5,000 vertices or is not an array.');
  const ring: Ring = [];
  for (const p of value) {
    if (!Array.isArray(p) || p.length !== 2 || !p.every(v => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= LIMITS.extent)) throw Error('Coordinates must be finite and within 100,000 mm.');
    if (!ring.length || !same(ring[ring.length-1], p as Point)) ring.push(p as Point);
  }
  if (ring.length && same(ring[0],ring[ring.length-1])) ring.pop();
  if (ring.length < 3 || Math.abs(area(ring)) <= 1e-10) throw Error('Contour has fewer than three vertices or is numerically degenerate.');
  for(let i=0;i<ring.length;i++) {
    const a=ring[(i+ring.length-1)%ring.length],b=ring[i],c=ring[(i+1)%ring.length];
    if(orient(a,b,c)===0 && (b[0]-a[0])*(c[0]-b[0])+(b[1]-a[1])*(c[1]-b[1])<0) throw Error('Contour doubles back along an adjacent edge.');
  }
  // ponytail: O(n²) validation is bounded at 5,000 vertices and runs in a worker;
  // replace with a sweep line if measured import latency requires it.
  for (let i=0;i<ring.length;i++) for (let j=i+1;j<ring.length;j++) {
    if (j === i+1 || (i === 0 && j === ring.length-1)) continue;
    if (intersects(ring[i],ring[(i+1)%ring.length],ring[j],ring[(j+1)%ring.length])) throw Error('Contour self-intersects or repeats an edge.');
  }
  return area(ring) < 0 ? ring.reverse() : ring;
}
/** Canonical open profile: bottom endpoint first at y=0 and top endpoint last at y=height. */
export function normalizeMaterialLeftEdge(value: unknown, height: number): Ring {
  if(!Array.isArray(value)||value.length<2||value.length>LIMITS.verticesPerPart)throw Error('Material profile must contain 2–5,000 points.');
  if(!Number.isFinite(height)||height<=0||height>LIMITS.extent)throw Error('Material height must be positive and at most 100,000 mm.');
  let profile:Ring=[];
  for(const point of value) {
    if(!Array.isArray(point)||point.length!==2||!point.every(v=>typeof v==='number'&&Number.isFinite(v)&&Math.abs(v)<=LIMITS.extent))throw Error('Material profile coordinates must be finite and within 100,000 mm.');
    const p=point as Point;
    if(!profile.length||!same(profile.at(-1)!,p))profile.push(p);
  }
  if(profile.length<2)throw Error('Material profile needs two distinct endpoints.');
  if(profile[0][1]===profile.at(-1)![1])throw Error('Material profile endpoints must have different heights.');
  if(profile[0][1]>profile.at(-1)![1])profile.reverse();
  const bottom=profile[0],top=profile.at(-1)!,low=bottom[1],high=top[1];
  if(high-low<=1e-6)throw Error('Material profile height is too small.');
  if(profile.some(([,_y])=>_y<low-1e-6||_y>high+1e-6))throw Error('Material profile must stay between its bottom and top endpoints.');
  const minX=Math.min(...profile.map(p=>p[0]));
  const scale=height/(high-low);
  profile=profile.map(([x,y])=>[x-minX,Math.max(0,Math.min(height,(y-low)*scale))]);
  profile[0]=[profile[0][0],0];profile[profile.length-1]=[profile.at(-1)![0],height];
  if(new Set(profile.map(p=>`${p[0]},${p[1]}`)).size!==profile.length)throw Error('Material profile repeats a point.');
  const maxX=Math.max(...profile.map(p=>p[0])),minimumLength=maxX+Math.max(height,maxX,1)*2e-5,previewLength=maxX+Math.max(height,1);
  if(minimumLength>LIMITS.extent||previewLength>LIMITS.extent)throw Error('Material profile leaves no room for the right edge within the 100,000 mm limit.');
  // Validate the open profile as part of a sufficiently wide closed sheet.
  normalizeRing(materialOutline(profile,height,previewLength));
  return profile;
}
export function materialOutline(profile:Ring,height:number,length:number):Ring {
  if(!Number.isFinite(length)||length<=0||!Number.isFinite(height)||height<=0)throw Error('Material outline dimensions must be positive.');
  if(length<=Math.max(...profile.map(p=>p[0])))throw Error('The right edge must lie to the right of the entire material profile.');
  return [...profile,[length,height],[length,0]];
}
export function normalizePart(part: Part): Part {
  if (typeof part.id !== 'string' || !part.id || typeof part.name !== 'string' || !part.source || !['svg','dxf','sparrow','drawn'].includes(part.source.format)) throw Error('Invalid part identity or provenance.');
  if (!Number.isInteger(part.quantity) || part.quantity < 0 || part.quantity > LIMITS.copies) throw Error('Quantity must be a whole number from 0 to 500.');
  if (!Number.isFinite(part.approximationToleranceMm) || part.approximationToleranceMm < 0 || part.approximationToleranceMm > 100) throw Error('Invalid approximation tolerance.');
  if (!Array.isArray(part.preparationPosition) || part.preparationPosition.length !== 2 || !part.preparationPosition.every(Number.isFinite)) throw Error('Invalid preparation position.');
  if (!part.rotations || (part.rotations.kind !== 'continuous' && (part.rotations.kind !== 'discrete' || !Array.isArray(part.rotations.degrees) || !part.rotations.degrees.length || !part.rotations.degrees.every(Number.isFinite)))) throw Error('Discrete rotations require a nonempty list of finite degrees.');
  const outer = normalizeRing(part.outer);
  if (!Array.isArray(part.holes)) throw Error('Holes must be an array.');
  const holes = part.holes.map(normalizeRing);
  if (outer.length + holes.reduce((n,h) => n+h.length,0) > LIMITS.verticesPerPart) throw Error('Part exceeds 5,000 vertices including holes.');
  for (let i=0;i<holes.length;i++) {
    if (!inside(holes[i][0],outer) || ringCrosses(outer,holes[i])) throw Error('Hole must be strictly inside its outer contour.');
    for(let j=0;j<i;j++) if (ringCrosses(holes[i],holes[j]) || inside(holes[i][0],holes[j]) || inside(holes[j][0],holes[i])) throw Error('Holes overlap or contain each other.');
  }
  return { ...part, outer, holes: holes.map(h => [...h].reverse()) };
}
export function scalePart(part:Part,factor:number):Part {
  if(!Number.isFinite(factor)||factor<=0)throw Error('Scale must be finite and positive.');
  const scale=(ring:Ring):Ring=>ring.map(([x,y])=>[x*factor,y*factor]);
  return normalizePart({...part,outer:scale(part.outer),holes:part.holes.map(scale),approximationToleranceMm:part.approximationToleranceMm*factor});
}
export function normalizeDocument(doc: Document, allowEmpty=false): Document {
  if (typeof doc.name !== 'string' || !doc.name.trim() || !Array.isArray(doc.parts) || (!allowEmpty&&!doc.parts.length) || doc.parts.length > 500) throw Error('Project needs 1–500 part types.');
  const s = doc.settings;
  if (!s || !Number.isFinite(s.materialWidthMm) || s.materialWidthMm <= 0 || s.materialWidthMm > LIMITS.extent || !Number.isFinite(s.clearanceMm) || s.clearanceMm < 0 || s.clearanceMm >= s.materialWidthMm || (s.timeLimitSeconds!==null && ![10,30,60,120,300,600].includes(s.timeLimitSeconds))) throw Error('Invalid material width, clearance, or run duration.');
  if(s.solverPreset!==undefined&&!['standard','fast'].includes(s.solverPreset))throw Error('Invalid solver preset.');
  const parts = doc.parts.map(normalizePart);
  if (new Set(parts.map(p=>p.id)).size !== parts.length) throw Error('Part IDs must be unique.');
  if (parts.reduce((n,p)=>n+p.quantity,0) > LIMITS.copies || parts.reduce((n,p)=>n+p.quantity*(p.outer.length+p.holes.reduce((m,h)=>m+h.length,0)),0) > LIMITS.verticesTotal) throw Error('Project exceeds 500 copies or 100,000 demanded vertices.');
  if (doc.placements !== undefined) {
    if (!Array.isArray(doc.placements)) throw Error('Placements must be an array.');
    const ids = new Set(parts.map(p=>p.id)), seen = new Set<string>();
    for (const placement of doc.placements as Placement[]) {
      if (!placement || typeof placement.partId !== 'string' || !ids.has(placement.partId)
        || !Number.isInteger(placement.copyIndex) || placement.copyIndex < 0
        || !Number.isFinite(placement.xMm) || !Number.isFinite(placement.yMm)
        || Math.abs(placement.xMm) > LIMITS.extent || Math.abs(placement.yMm) > LIMITS.extent
        || !Number.isFinite(placement.angleDeg)) throw Error('Invalid copy placement.');
      const part = parts.find(p=>p.id===placement.partId)!;
      if (placement.copyIndex >= part.quantity) throw Error('Copy placement exceeds its quantity.');
      const key = `${placement.partId}:${placement.copyIndex}`;
      if (seen.has(key)) throw Error('Copy placements must be unique.');
      seen.add(key);
    }
  }
  const settings={...s,...(s.materialLeftEdge===undefined?{}:{materialLeftEdge:normalizeMaterialLeftEdge(s.materialLeftEdge,s.materialWidthMm)})};
  return { ...doc, settings, parts };
}
