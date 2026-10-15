import { readLines, extractSites } from './lib/extract.mjs';
const [src, dist] = process.argv.slice(2);
const hists = {};
for (const [label, p] of [['SOURCE', src], ['DIST', dist]]) {
  const sites = extractSites(readLines(p));
  const m = new Map();
  for (const s of sites) { const k = s.guard == null ? '<NULL>' : s.guard; m.set(k, (m.get(k) || 0) + 1); }
  hists[label] = { sites, m };
  const rows = [...m.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`== ${label} : ${sites.length} sites, ${rows.length} distinct guards`);
  for (const [k, n] of rows.slice(0, 14)) console.log(`  ${String(n).padStart(3)}  ${String(k).slice(0, 96)}`);
}

// The agreement line is the content proof, and it must be reproducible from THIS
// tool rather than from an ad-hoc script. It also independently predicts the
// anchor's CONTENT/ORDER split: sites in singleton buckets are exactly the sites
// guard text alone can place.
const S = hists.SOURCE, D = hists.DIST;
const keys = new Set([...S.m.keys(), ...D.m.keys()]);
let agree = 0;
for (const k of keys) if ((S.m.get(k) || 0) === (D.m.get(k) || 0)) agree++;
const hist = {};
for (const n of S.m.values()) hist[n] = (hist[n] || 0) + 1;
const singletonSites = hist[1] || 0;
console.log('== CROSS-TREE AGREEMENT');
console.log(`  union of guard keys : ${keys.size}`);
console.log(`  src-only keys       : ${[...S.m.keys()].filter((k) => !D.m.has(k)).length}`);
console.log(`  dist-only keys      : ${[...D.m.keys()].filter((k) => !S.m.has(k)).length}`);
console.log(`  buckets agreeing    : ${agree}   disagreeing: ${keys.size - agree}`);
console.log(`  bucket-size hist    : ${Object.keys(hist).sort((a, b) => a - b).map((k) => `${k}->${hist[k]}`).join('  ')}`);
console.log(`  sites in size-1 buckets: ${singletonSites} / ${S.sites.length}   (must equal source-anchor's content-proven count)`);
