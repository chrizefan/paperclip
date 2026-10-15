// Builds two mutated DIST trees to find out what source-anchor.mjs can and
// cannot catch. Both are measured on the installed build's dist, run against
// the pinned source.
// (a) remove ONE skip site -> site COUNT changes; the count invariant alone
//     fires, and the refusal names the unplaced source site.
// (b) remove one occurrence in a guard group and add one later in the SAME
//     group -> site count AND every guard-bucket size are UNCHANGED (65 = 65,
//     'updated' 15 = 15), so the count invariant stays green.
// MEASURED RESULT, recorded so nobody re-derives it expecting a catch:
//   (a) source-anchor REFUSES, EXIT=2, 2 FATAL lines.
//   (b) source-anchor returns EXIT=0 with 65 placements. NOTHING catches it.
// This is the structural limit of order-preserving pairing inside a guard
// bucket, and it is why 36 of 65 placements are reported ORDER-resolved rather
// than content-proven. There was an ordinal-skew check here once; it was
// DELETED as tautological (inside a bucket both ordinals ARE k, so skew is zero
// by construction) rather than shipped as a guard that cannot fail.
import fs from 'node:fs';
import { readLines, extractSites } from './lib/extract.mjs';
const [distPath, outDir] = process.argv.slice(2);
const lines = readLines(distPath);
const upd = extractSites(lines).filter((s) => s.guard === 'updated');
if (upd.length < 11) { console.error(`need >=11 'updated' sites, have ${upd.length}`); process.exit(3); }

const dropIdx = upd[1].line - 1;                 // remove occurrence #2
const hostIdx = upd[9].line - 1;                  // add a new one inside occurrence #10's block
// Index drift: removing the earlier line shifts the host. Recompute it, never
// reuse a pre-removal index (the bug that put this in a `!timeZone` block before).
const a = lines.slice(); a.splice(dropIdx, 1);
const hostAfter = hostIdx - (dropIdx < hostIdx ? 1 : 0);
a.splice(hostAfter + 1, 0, '      result.skipped += 1;');
const pa = `${outDir}/counterfactual-a-removed-one.js`;
const pb = `${outDir}/counterfactual-b-count-preserving.js`;
fs.writeFileSync(pa, lines.filter((_, i) => i !== dropIdx).join('\n'));
fs.writeFileSync(pb, a.join('\n'));
console.log(`removed site line ${upd[1].line} (guard 'updated' #2)`);
console.log(`added   site into block of line ${upd[9].line} (guard 'updated' #10)`);
const cf = extractSites(a);
const orig = extractSites(lines);
console.log(`sites in original ${orig.length}, in counterfactual ${cf.length}`);
console.log(`guard 'updated': original ${orig.filter((s) => s.guard === 'updated').length}, counterfactual ${cf.filter((s) => s.guard === 'updated').length}`);
console.log(pa);
console.log(pb);
