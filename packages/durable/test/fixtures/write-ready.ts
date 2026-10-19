// The handshake a fixture process gives its test: a file whose contents say it is ready.
// The test polls for the file and reads it at once, so the file must appear whole: written
// beside it, then renamed into place. A plain writeFileSync creates it empty first, and a
// read in between sees '' (Number('') is 0 — a pid of 0).
import { renameSync, writeFileSync } from 'node:fs';

export function writeReady(path: string, text: string): void {
  writeFileSync(`${path}.partial`, text);
  renameSync(`${path}.partial`, path);
}
