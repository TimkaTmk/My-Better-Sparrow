import type { SolverBinary } from '../wasm';
import { SOLVER_REVISION, type Job, type Result, type Validation } from '../model';
import type { ImportReview } from '../import/sparrow';
import type { ExportBundle } from '../export/svg';
import type { LiveGeometry } from '../geometry/live';
export type Identity = { runId: number; documentRevision: number };
export type Start = Identity & { type: 'start'; document: Job; seed: string; threads?: number; control?: SharedArrayBuffer };
export type RuntimeStart = Start & { threads: number; manualThreads: boolean };
export type Placement = { item_id: number; transformation: { rotation: number; translation: [number, number] } };
export type SolverMessage = Identity & (
  | { type: 'ready'; threads: number; solverBinary: SolverBinary; simd: boolean; canSkip: boolean; fallbackReason?: string }
  | { type: 'phase'; phase: string; workers: number; initializationMs: number }
  | (({ type:'candidate' }|{ type:'live' }) & { sequence:number; report:string; elapsedMs:number; validation?:Validation;
      solution: { strip_width: number; layout: { placed_items: Placement[] } } })
  | { type: 'solver-log'; line:string; timestamp:number }
  | { type:'run-input'; input:string; seed:string; seconds:number|null; clearance:number; preset:string; threads:number; solverBinary:SolverBinary }
  | { type:'configuration'; configuration:string }
  | { type: 'finished' }
  | { type: 'error'; message: string }
);
export type Candidate = Extract<SolverMessage,{sequence:number}>;
export function candidateResult(doc:Job,candidate:Candidate,seed:string):Result {
  const copies=new Map<string,number>(),parts=doc.parts.filter(part=>part.quantity>0);
  return {documentRevision:candidate.documentRevision,solverRevision:SOLVER_REVISION,seed,
    elapsedSeconds:candidate.elapsedMs/1000,usedLengthMm:candidate.solution.strip_width,
    placements:candidate.solution.layout.placed_items.map(p=>{
      const partId=parts[p.item_id]?.id ?? `unknown:${p.item_id}`;
      const copyIndex=copies.get(partId) ?? 0; copies.set(partId,copyIndex+1);
      return {partId,copyIndex,xMm:p.transformation.translation[0],yMm:p.transformation.translation[1],angleDeg:p.transformation.rotation};
    }), validation:candidate.validation ?? {status:'pending',overlapAreaMm2:0,maxBoundaryViolationMm:0,minClearanceMm:null,errors:[]}};
}
export type ImportFile = { name: string; text: string };
export type GeometryRequest = Identity & (
  | { type:'normalize'; document:Job }
  | { type:'import'; files:ImportFile[]; scale:number; overrideDxfUnits?:boolean; tolerance?:number; enclosed?:'holes'|'parts'; layers?:string[] }
  | { type:'export'; document:Job; result:Result }
  | { type:'live-preview'; sequence:number; document:Job; result:Result }
);
export type GeometryReply = Identity & (
  | { type:'normalized'; document:Job }
  | { type:'import-review'; review:ImportReview }
  | { type:'export-result'; bundle:ExportBundle }
  | { type:'live-frame'; sequence:number; geometry:LiveGeometry }
  | { type:'error'; message:string }
);
