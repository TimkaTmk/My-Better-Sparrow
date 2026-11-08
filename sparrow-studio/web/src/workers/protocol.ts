import type { SolverBinary } from '../wasm';
import { SOLVER_REVISION, type Document, type Part, type Point, type Result, type Validation } from '../model';
import type { ImportReview } from '../import/sparrow';
import type { ExportBundle } from '../export/svg';
import type { LiveGeometry } from '../geometry/live';
import type {GeometryEdit} from '../geometry/manipulate';
import type {CopyRef} from '../geometry/placements';
import type {LabelPoint} from '../geometry/preparation';
export type Identity = { runId: number; documentRevision: number };
export type Start = Identity & { seed: string; threads?: number; control?: SharedArrayBuffer } & (
  | { type: 'start'; document: Document }
  | { type: 'bridge'; input: string; seconds: 10 }
);
export type RuntimeStart = Start & { threads: number; manualThreads: boolean };
export type Placement = { item_id: number; transformation: { rotation: number; translation: [number, number] } };
export type SolverMessage = Identity & (
  | { type: 'ready'; threads: number; solverBinary: SolverBinary; simd: boolean; canSkip: boolean; fallbackReason?: string }
  | { type: 'phase'; phase: string; workers: number; initializationMs: number }
  | (({ type:'candidate' }|{ type:'live' }) & { sequence:number; report:string; elapsedMs:number; validation?:Validation; validationMs?:number;
      solution: { strip_width: number; layout: { placed_items: Placement[] } } })
  | { type: 'solver-log'; line:string; timestamp:number }
  | { type:'run-input'; input:string; seed:string; seconds:number|null; clearance:number; preset:string; threads:number; solverBinary:SolverBinary }
  | { type:'configuration'; configuration:string }
  | { type: 'finished' }
  | { type: 'error'; message: string }
);
export type Candidate = Extract<SolverMessage,{sequence:number}>;
export function candidateResult(doc:Document,candidate:Candidate,seed:string):Result {
  const copies=new Map<string,number>(),parts=doc.parts.filter(part=>part.quantity>0);
  return {documentRevision:candidate.documentRevision,solverRevision:SOLVER_REVISION,seed,
    elapsedSeconds:candidate.elapsedMs/1000,usedLengthMm:candidate.solution.strip_width,
    placements:candidate.solution.layout.placed_items.map(p=>{
      const partId=parts[p.item_id]?.id ?? `unknown:${p.item_id}`;
      const copyIndex=copies.get(partId) ?? 0; copies.set(partId,copyIndex+1);
      return {partId,copyIndex,xMm:p.transformation.translation[0],yMm:p.transformation.translation[1],angleDeg:p.transformation.rotation};
    }), validation:candidate.validation ?? {status:'pending',overlapAreaMm2:0,maxBoundaryViolationMm:0,minClearanceMm:null,errors:[]}};
}
export type GeometryRequest = Identity & (
  | { type:'shape'; shape:'rectangle'|'circle'|'polygon'; width:number; height:number; points?:Point[] }
  | { type:'normalize'; document:Document }
  | { type:'prepare-layout'; document:Document; pinnedIds?:string[]; compact?:boolean }
  | { type:'label-points'; parts:Part[] }
  | { type:'resize'; document:Document; partId:string; axis:0|1; sizeMm:number }
  | { type:'edit-selection'; document:Document; ids:string[]; edit:GeometryEdit; refs?:CopyRef[] }
  | { type:'library'; text:string; fileName:string }
  | { type:'import'; files:{name:string;text:string}[]; scale:number; overrideDxfUnits?:boolean; tolerance?:number; enclosed?:'holes'|'parts'; layers?:string[] }
  | { type:'export'; document:Document; result?:Result }
  | { type:'archive'; document:Document; result?:Result }
  | { type:'live-preview'; sequence:number; document:Document; result:Result }
);
export type GeometryReply = Identity & (
  | { type:'part'; part:Part }
  | { type:'normalized'; document:Document }
  | { type:'label-points'; points:LabelPoint[] }
  | { type:'import-review'; review:ImportReview }
  | { type:'export-result'; bundle:ExportBundle }
  | { type:'archive-result'; archive:Uint8Array }
  | { type:'live-frame'; sequence:number; geometry:LiveGeometry }
  | { type:'error'; message:string }
);
