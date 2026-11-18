import { expect, it } from 'vitest';
import { DEFAULT_SETTINGS, newPart, type Document, type Result } from '../src/model';
import { normalizeDocument } from '../src/geometry/normalize';
import { validate,worldParts } from '../src/geometry/validate';
import { importProject,exportProject } from '../src/import/project';
import { solverInput } from '../src/import/sparrow';
import { exportDXF } from '../src/export/dxf';
import { exportSVG } from '../src/export/svg';

function setup(xMm:number):{document:Document;result:Result} {
  const part=newPart([[0,0],[2,0],[2,2],[0,2]],'Square');
  const document:Document={name:'Profile material',parts:[part],settings:{...DEFAULT_SETTINGS,materialWidthMm:10,materialLeftEdge:[[0,0],[5,5],[0,10]]}};
  const result:Result={documentRevision:1,solverRevision:'test',seed:'1',elapsedSeconds:0,usedLengthMm:30,
    placements:[{partId:part.id,copyIndex:0,xMm,yMm:4,angleDeg:0}],
    validation:{status:'pending',overlapAreaMm2:0,maxBoundaryViolationMm:0,minClearanceMm:null,errors:[]}};
  return {document,result};
}

it('validates against the actual left profile, not only its rectangular bounds',()=>{
  const outside=setup(1),safe=setup(10);
  expect(validate(outside.document,outside.result).errors).toContain('Copy 1 extends outside the custom material profile.');
  expect(validate(safe.document,safe.result).status).toBe('passed');
});

it('checks the requested clearance from the custom material boundary',()=>{
  const {document,result}=setup(6.1);
  document.settings.clearanceMm=5;
  expect(validate(document,result).errors).toContain('Copy 1 is closer than 5 mm to the material boundary.');
});

it('normalizes the profile in saved documents and passes it to the solver input',()=>{
  const {document}=setup(10),normalized=normalizeDocument(document);
  expect(normalized.settings.materialLeftEdge).toEqual([[0,0],[5,5],[0,10]]);
  expect(JSON.parse(solverInput(normalized)).strip_left_boundary).toEqual(normalized.settings.materialLeftEdge);
  expect(JSON.parse(solverInput({...normalized,settings:{...normalized.settings,materialLeftEdge:undefined}}))).not.toHaveProperty('strip_left_boundary');
});

it('round trips the custom material contour through project and DXF exports',()=>{
  const {document,result}=setup(10),valid={...result,validation:validate(document,result)};
  expect(valid.validation.status).toBe('passed');
  const saved=exportProject(document,1),opened=importProject(saved);
  expect(opened.document.settings.materialLeftEdge).toEqual(document.settings.materialLeftEdge);
  const dxf=exportDXF(document,worldParts(document,valid),valid.usedLengthMm);
  expect(dxf).toContain('\n8\nSPARROW_SHEET\n');
  expect(dxf).toContain('\n10\n5\n20\n5\n');
  expect(exportSVG(document).svg).toContain('translate(0 10) scale(1 -1)');
});
