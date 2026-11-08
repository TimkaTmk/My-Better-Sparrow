import type { Document, Result } from '../model';
import { solverInput } from '../import/sparrow';
import { exportProject } from '../import/project';
import { exportSVG } from './svg';

import {zip,type ZipEntry} from '../zip';
export {zip,projectArchiveText} from '../zip';

const ARCHIVE_README = `sparrow/studio archive

project.sparrow-project.json is the editable Studio project and preserves holes.
cli.json is omitted when the project has no active copies.
layout.svg and layout.dxf are checked-result exports and preserve holes when present.
cli.json includes hole contours and clearance. Use the local Sparrow CLI with hole support to solve it.
`;

/** Package the editable project, CLI input, and optional checked-result exports. */
export function exportProjectArchive(document: Document, revision: number, result?: Result): Uint8Array {
  const entries: ZipEntry[] = [
    { name: 'project.sparrow-project.json', data: exportProject(document, revision, result) },
    ...(document.parts.some(part => part.quantity > 0) ? [{ name: 'cli.json', data: solverInput(document) }] : []),
    { name: 'README.txt', data: ARCHIVE_README },
  ];
  if (result) {
    const bundle = exportSVG(document, result);
    entries.push({ name: 'layout.svg', data: bundle.svg }, { name: 'layout.dxf', data: bundle.dxf });
  }
  const archive = zip(entries);
  if (archive.byteLength > 25 * 1024 * 1024) throw Error('Project ZIP exceeds the 25 MiB limit. Reduce the project before saving.');
  return archive;
}
