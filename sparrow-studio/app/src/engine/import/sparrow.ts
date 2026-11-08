import { DEFAULT_SETTINGS, newPart, type Job, type Part, type Ring } from '../model';
import { bounds, normalizeJob, normalizeRing } from '../geometry/normalize';

export type ImportReview = { document: Job; warnings: string[]; issues?:string[]; layers?:string[] };
export function record(value: unknown): Record<string,unknown> {
  if(!value || typeof value!=='object' || Array.isArray(value)) throw Error('Expected an object.');
  return value as Record<string,unknown>;
}
export function number(value: unknown): number {
  if(typeof value!=='number' || !Number.isFinite(value)) throw Error('Expected a finite number.');
  return value;
}
export function localize(part: Part): Part {
  const [x,y]=bounds(part.outer);
  const shift=(ring: Ring): Ring=>ring.map(p=>[p[0]-x,p[1]-y]);
  return {...part,outer:shift(part.outer),holes:part.holes.map(shift)};
}

function importRotations(item: Record<string, unknown>, id: number): Part['rotations'] {
  if (item.orientation !== undefined) {
    const orientation = record(item.orientation), rotation = record(orientation.rotation);
    if (orientation.reflection_axes !== undefined && (!Array.isArray(orientation.reflection_axes) || orientation.reflection_axes.length))
      throw Error(`Item ${id}: Studio placements support rotations and translations only.`);
    if (rotation.mode === 'continuous') return {kind:'continuous'};
    if (rotation.mode === 'discrete' && Array.isArray(rotation.angles) && rotation.angles.length)
      return {kind:'discrete', degrees:rotation.angles.map(number)};
    if (rotation.mode === 'stepped') {
      const step = number(rotation.step), count = Math.round(360 / step);
      if (step > 0 && count >= 1 && count <= 65_536 && Math.abs(count * step - 360) < 0.000043)
        return {kind:'discrete', degrees:Array.from({length:count}, (_, i) => i * 360 / count)};
    }
    throw Error(`Item ${id}: invalid orientation.rotation.`);
  }
  const angles = item.allowed_orientations;
  if (angles == null) return {kind:'continuous'};
  if (!Array.isArray(angles) || !angles.length || !angles.every(a=>typeof a==='number' && Number.isFinite(a)))
    throw Error(`Item ${id}: allowed_orientations must be omitted for free rotation or a nonempty degree list.`);
  return {kind:'discrete',degrees:angles};
}

export function importSparrow(text: string,fileName: string,scale: number): ImportReview {
  if(!Number.isFinite(scale) || scale<=0) throw Error('Choose a positive millimeter scale.');
  const input=record(JSON.parse(text));
  if(typeof input.name!=='string' || !Array.isArray(input.items) || input.items.length>500) throw Error('Expected a sparrow ExtSPInstance with name and items.');
  const ids=new Set<number>();
  const parts=input.items.map(raw=>{
    const item=record(raw),shape=record(item.shape),id=number(item.id);
    if(!Number.isSafeInteger(id) || id<0 || ids.has(id)) throw Error('sparrow item IDs must be unique nonnegative safe integers.');
    ids.add(id);
    let outer: Ring,holes: Ring[]=[];
    const scaled=(ring: unknown): Ring=>normalizeRing(ring).map(p=>[p[0]*scale,p[1]*scale]);
    if(shape.type==='simple_polygon') outer=scaled(shape.data);
    else if(shape.type==='polygon') {
      const data=record(shape.data);
      outer=scaled(data.outer);
      if(data.inner!==undefined && !Array.isArray(data.inner)) throw Error('Polygon inner contours must be an array.');
      holes=((data.inner ?? []) as unknown[]).map(scaled);
    } else if(shape.type==='rectangle') {
      const d=record(shape.data),x=number(d.x_min),y=number(d.y_min),w=number(d.width),h=number(d.height);
      if(w<=0 || h<=0) throw Error('Rectangle dimensions must be positive.');
      outer=scaled([[x,y],[x+w,y],[x+w,y+h],[x,y+h]]);
    } else throw Error(`Item ${id}: ${String(shape.type)} is unsupported. Disjoint JSON items cannot be split without changing demand.`);
    return localize({...newPart(outer,`Part ${id}`),holes,quantity:number(item.demand),
      source:{format:'sparrow',fileName,entityId:String(id)},
      rotations: importRotations(item,id)});
  });
  const clearanceMm = input.min_item_separation === undefined ? 0 : number(input.min_item_separation) * scale;
  return {document:normalizeJob({name:input.name,parts,settings:{...DEFAULT_SETTINGS,materialWidthMm:number(input.strip_height)*scale,clearanceMm}}),
    warnings:[...(input.solution!==undefined?['Stored native solution is ignored; warm starts are not supported.']:[]),
      `One coordinate unit = ${scale} mm. Benchmark coordinates have no intrinsic manufacturing units.`]};
}
export function solverInput(doc: Job): string {
  if(!doc.parts.some(part=>part.quantity>0))throw Error('Add at least one copy before nesting.');
  return JSON.stringify({name:doc.name,strip_height:doc.settings.materialWidthMm,min_item_separation:doc.settings.clearanceMm,items:doc.parts.filter(part=>part.quantity>0).map((p,id)=>({
    id,demand:p.quantity,
    orientation:{rotation:p.rotations.kind==='continuous'?{mode:'continuous'}:{mode:'discrete',angles:p.rotations.degrees}},
    shape:p.holes.length?{type:'polygon',data:{outer:p.outer,inner:p.holes}}:{type:'simple_polygon',data:p.outer},
  }))});
}
