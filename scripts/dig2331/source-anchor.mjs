#!/usr/bin/env node
// source-anchor.mjs — anchor a source tree's skip sites onto a build's skip sites.
//
// Method: order-preserving alignment WITHIN A GUARD GROUP.
//   1. extract every `result.skipped += 1` site from both trees, each carrying the
//      text of the innermost enclosing `if` (the guard);
//   2. bucket both sides by normalised guard text;
//   3. inside a bucket, pair source occurrence k with dist occurrence k.
//
// No line arithmetic and no constant offset: a line drift or neighbourhood churn
// cannot move a placement, and only a genuine edit to the same expression changes
// a guard's text. When the pairing cannot be completed the tool REFUSES and names
// the sites; it never guesses. Exit 2 on any refusal (shape copied from
// `rearm-after-upgrade.mjs --check`).
//
// Two invariants the site-count check does not cover, checked below:
//   * INJECTIVITY — the normalised guard key must be injective over each tree, or
//     bucket pairing is ambiguous in a way no count can reveal.
//   * (there is deliberately NO ordinal-skew check: inside a guard bucket the
//     pairing is k-th to k-th, so both ordinals ARE k and the skew is zero by
//     construction. The invariant could not fail. probe-03 shows the consequence:
//     a count-preserving, same-group mutation is caught by nothing here.)

import { readLines, extractSites, normalizeExpr } from './lib/extract.mjs';

const argv = process.argv.slice(2);
const arg = (name, dflt = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt;
};
const flag = (name) => argv.includes(name);

const SOURCE = arg('--source');
const DIST = arg('--dist');
if (!SOURCE || !DIST) {
  console.error('usage: source-anchor.mjs --source <service.ts> --dist <service.js> [--json] [--ambiguous]');
  process.exit(64);
}

const srcSites = extractSites(readLines(SOURCE));
const distSites = extractSites(readLines(DIST));

// ---- alignment -------------------------------------------------------------
function bucket(sites) {
  const m = new Map();
  for (const s of sites) {
    const k = s.guard == null ? null : normalizeExpr(s.guard);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(s);
  }
  for (const arr of m.values()) arr.forEach((s, i) => { s.ordinal = i; });
  return m;
}
const srcB = bucket(srcSites);
const distB = bucket(distSites);

const placements = [];
const dropped = [];   // source sites with no dist partner
const added = [];     // dist sites with no source partner
const refusals = [];

for (const [key, sArr] of srcB) {
  const dArr = distB.get(key) || [];
  // An unequal bucket cannot be paired by position: the missing site may be
  // in the middle, so the shared prefix is not a placement. Refuse the whole
  // bucket and name every line on both sides.
  if (sArr.length !== dArr.length) {
    for (const s of sArr) dropped.push(s);
    for (const d of dArr) added.push(d);
    continue;
  }
  for (let k = 0; k < sArr.length; k++) {
    placements.push({
      src: sArr[k].line, dist: dArr[k].line,
      guard: key, ordinal: k,
      // ORDER-resolved: the guard repeats, so text alone cannot pick this
      // occurrence out of the group — only its position in the group can.
      resolvedBy: (sArr.length === 1 && dArr.length === 1) ? 'CONTENT' : 'ORDER',
    });
  }
}
for (const [key, dArr] of distB) {
  if (!srcB.has(key)) for (const d of dArr) added.push(d);
}

// SECOND INVARIANT, and it replaces the dead ordinal check: the guard key must
// be INJECTIVE over the source tree. If two different raw guards normalised to
// the same key, "bucket pairing" would be content-ambiguous in a way no count
// can reveal, so refuse and name both lines.
{
  const srcRaw = new Map();   // normalised key -> raw guard strings seen
  for (const s0 of srcSites) {
    if (s0.guard == null) continue;
    const k = normalizeExpr(s0.guard);
    if (!srcRaw.has(k)) srcRaw.set(k, new Set());
    srcRaw.get(k).add(s0.guard);
  }
  for (const [k, raws] of srcRaw) {
    if (raws.size > 1) {
      refusals.push(`guard key not injective over source: ${[...raws].map((r) => `\`${r}\``).join('  vs  ')}`);
    }
  }
  const distRaw = new Map();
  for (const d0 of distSites) {
    if (d0.guard == null) continue;
    const k = normalizeExpr(d0.guard);
    if (!distRaw.has(k)) distRaw.set(k, new Set());
    distRaw.get(k).add(d0.guard);
  }
  for (const [k, raws] of distRaw) {
    if (raws.size > 1) {
      refusals.push(`guard key not injective over dist: ${[...raws].map((r) => `\`${r}\``).join('  vs  ')}`);
    }
  }
}

if (srcSites.length !== distSites.length) {
  refusals.push(`skip-site count changed: ${srcSites.length} anchored, ${distSites.length} installed`);
}
for (const d of dropped) {
  const key = d.guard == null ? null : normalizeExpr(d.guard);
  refusals.push(`unplaced source site at line ${d.line}: guard \`${key}\` has ${(srcB.get(key) || []).length} source occurrence(s) and ${(distB.get(key) || []).length} dist occurrence(s)`);
}
for (const a of added) {
  const key = a.guard == null ? null : normalizeExpr(a.guard);
  refusals.push(`unplaced dist site at line ${a.line}: guard \`${key}\` has no source partner at this build`);
}

placements.sort((a, b) => a.src - b.src);
const orderResolved = placements.filter((p) => p.resolvedBy === 'ORDER');

// ---- report ----------------------------------------------------------------
const jsonOut = flag('--json');
if (jsonOut) {
  console.log(JSON.stringify({
    source: SOURCE, dist: DIST,
    srcSites: srcSites.length, distSites: distSites.length,
    placements, dropped, added, refusals,
    orderResolved: orderResolved.length,
  }, null, 2));
} else {
  console.log(`source            : ${SOURCE}`);
  console.log(`dist              : ${DIST}`);
  console.log(`skip sites        : source ${srcSites.length} / dist ${distSites.length}`);
  console.log(`placements        : ${placements.length}`);
  console.log(`dropped (source)  : ${dropped.length}`);
  console.log(`new (dist)        : ${added.length}`);
  console.log(`content-proven    : ${placements.length - orderResolved.length}`);
  console.log(`order-resolved    : ${orderResolved.length}`);
  if (flag('--ambiguous')) {
    console.log('--- order-resolved placements (confirm these by hand) ---');
    for (const p of orderResolved) console.log(`  [ORDER-RESOLVED] src:${p.src} -> dist:${p.dist}  \`${p.guard}\``);
  }
  if (refusals.length) {
    for (const r of refusals) console.error(`FATAL: ${r}`);
    console.error(`REFUSING: ${refusals.length} fatal condition(s); no patch produced.`);
    process.exit(2);
  }
  console.log(`OK: ${placements.length} placement(s); ${placements.length - orderResolved.length} content-proven, ${orderResolved.length} order-resolved (confirm those by hand -- rerun with --ambiguous).`);
}
process.exit(refusals.length ? 2 : 0);
