// The instrument that killed EM's "approach 4" (order-preserving diagonal,
// scored against the truth set): pair site k with site k, then score each
// placement on GUARD TEXT. Truth-set membership cannot fail (the truth set IS the
// dist enumeration), so guard text is the only non-tautological scorer available.
import { readLines, extractSites, normalizeExpr } from './lib/extract.mjs';
const [src, dist] = process.argv.slice(2);
const s = extractSites(readLines(src));
const d = extractSites(readLines(dist));
const n = Math.min(s.length, d.length);
let exact = 0, wrong = 0;
for (let i = 0; i < n; i++) {
  if (normalizeExpr(s[i].guard) === normalizeExpr(d[i].guard)) exact++; else wrong++;
}
console.log(`scope            : WHOLE FILE (sites ${s.length} src / ${d.length} dist)`);
console.log(`diagonal pairs   : ${n}  (dist surplus ${d.length - s.length})`);
console.log(`guard EXACT      : ${exact}`);
console.log(`guard WRONG      : ${wrong}`);
