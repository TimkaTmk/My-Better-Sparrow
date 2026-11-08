import { loadSerialWasm, loadThreadedWasm, supportsSIMD, type SolverBinary } from '../wasm';
import { candidateResult, type RuntimeStart, type Start, type SolverMessage } from './protocol';
import { fitSolverCandidate, validateNormalized } from '../geometry/validate';
import { normalizeDocument } from '../geometry/normalize';
import { solverInput } from '../import/sparrow';

self.onmessage = async ({ data }: MessageEvent<RuntimeStart | {type:'preload';threads:number}>) => {
  if (data.type !== 'start' && data.type !== 'bridge' && data.type !== 'preload') return;
  const { runId, documentRevision } = data.type==='preload'?{runId:0,documentRevision:0}:data;
  const send = (message: object) => self.postMessage({ ...message, runId, documentRevision });
  try {
    let wasm: Pick<typeof import('../../wasm/pkg/sparrow_web'), 'run' | 'thread_count'>;
    if (data.threads && data.threads > 1) {
      const threaded = await loadThreadedWasm();
      await threaded.default();
      if(data.type!=='preload')await threaded.initThreadPool(data.threads);
      wasm = threaded;
    } else {
      const serial = await loadSerialWasm();
      await serial.default();
      wasm = serial;
    }
    // Download and compile off the UI thread; actual runs still own fresh workers.
    if(data.type==='preload'){self.postMessage({type:'preloaded'});self.close();return;}
    const solverBinary: SolverBinary = `${data.threads && data.threads > 1 ? 'threaded' : 'serial'}-${supportsSIMD ? 'simd' : 'nosimd'}`;
    const threads = wasm.thread_count();
    if (threads !== data.threads) throw Error(`Solver initialized ${threads} of ${data.threads} threads.`);
    send({ type: 'ready', threads, solverBinary, simd: supportsSIMD, canSkip: !!data.control });
    const doc=data.type==='start'?normalizeDocument(data.document):null;
    const input=doc?solverInput(doc):(data as Extract<Start,{type:'bridge'}>).input;
    const seconds=data.type==='bridge'?data.seconds:doc!.settings.timeLimitSeconds,clearance=doc?.settings.clearanceMm??0,preset=doc?.settings.solverPreset??'standard';
    send({type:'run-input',input,seed:data.seed,seconds,clearance,preset,threads,solverBinary});
    const control=data.control?new Int32Array(data.control):undefined;
    const perforated=doc?.parts.some(part=>part.quantity>0&&part.holes.length);
    let checkedLength=Infinity;
    wasm.run(input, seconds??undefined, data.seed, clearance, preset, (json: string) => {
      const message = JSON.parse(json) as SolverMessage;
      // Close the Skip gate synchronously, before the coordinator receives the phase change.
      if(control&&message.type==='phase'&&message.phase==='Compression')Atomics.store(control,0,-1);
      if(doc&&perforated&&message.type==='candidate') {
        if(message.solution.strip_width>=checkedLength) {
          send({...message,type:'live'});
          return;
        }
        const candidate=candidateResult(doc,{...message,runId,documentRevision},data.seed);
        const result=fitSolverCandidate(doc,candidate);
        const validationStarted=performance.now();
        message.validation=validateNormalized(doc,result,undefined,clearance);
        message.validationMs=performance.now()-validationStarted;
        if(message.validation.status==='passed') {
          if(result!==candidate) {
            message.solution.strip_width=result.usedLengthMm;
            message.solution.layout.placed_items.forEach((item,index)=>{
              const {xMm,yMm}=result.placements[index];
              item.transformation.translation=[xMm,yMm];
            });
          }
          checkedLength=Math.min(checkedLength,result.usedLengthMm);
        }
      }
      send(message);
    }, control?(reset:boolean)=>{if(reset)Atomics.compareExchange(control,0,1,0);return Atomics.load(control,0)===1;}:undefined, data.manualThreads);
  } catch (error) {
    send({ type: 'error', message: String(error) });
    if(data.type==='preload')self.close();
  }
};
