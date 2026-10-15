// Structural skip-site extractor. No dependencies.
//
// Finds every `result.skipped += 1` site in a JS/TS file and attributes it to the
// INNERMOST enclosing `if` condition (the "guard"). Runs unchanged on TypeScript
// source and on esbuild output, because it never looks at formatting: it walks
// braces and parens over a masked copy of each line in which string literals,
// template literals and comments are blanked (length preserved) so that a brace
// inside a string cannot move the stack.
//
// A skip inside `if (c) { ... } else { result.skipped += 1; }` is attributed to `c`:
// that is the condition the branch is chosen by, and it is also why `else` sites
// are the ambiguous class the anchor has to report rather than resolve silently.

import fs from 'node:fs';

export const SKIP_RE = /result\.skipped\s*\+=\s*1/;

// Whitespace-insensitive form of an expression, applied identically to both trees,
// so string literals with punctuation inside them normalise the same way on both.
export function normalizeExpr(s) {
  if (s == null) return null;
  return s
    .replace(/\s+/g, ' ')
    .replace(/\s*([()[\]{},:?&|=!<>+\-*/%;.])\s*/g, '$1')
    .trim()
    .replace(/,([)\]}])/g, '$1')
    .replace(/;$/, '');
}

export function readLines(path) {
  return fs.readFileSync(path, 'utf8').split('\n');
}

// Mask strings / template literals / comments. Length-preserving, so column
// positions in the masked line still index the raw line.
function maskLine(line, st) {
  const n = line.length;
  let out = '';
  let i = 0;
  const blank = (k) => { out += ' '.repeat(k); };
  while (i < n) {
    const c = line[i], d = line[i + 1];
    if (st.block) {
      if (c === '*' && d === '/') { blank(2); st.block = false; i += 2; continue; }
      blank(1); i++; continue;
    }
    if (st.tmpl) {
      if (c === '\\') { blank(2); i += 2; continue; }
      if (c === '`') { blank(1); st.tmpl = false; i++; continue; }
      blank(1); i++; continue;
    }
    if (st.q) {
      if (c === '\\') { blank(2); i += 2; continue; }
      if (c === st.q) { blank(1); st.q = null; i++; continue; }
      blank(1); i++; continue;
    }
    if (c === '/' && d === '/') { blank(n - i); break; }
    if (c === '/' && d === '*') { blank(2); st.block = true; i += 2; continue; }
    if (c === '/' && regexAllowed(out)) {           // regex literal, not division
      let k = i + 1, cls = false;
      while (k < n) {
        const e = line[k];
        if (e === '\\') { k += 2; continue; }
        if (e === '[') cls = true;
        else if (e === ']') cls = false;
        else if (e === '/' && !cls) break;
        k++;
      }
      blank(Math.min(k + 1, n) - i); i = Math.min(k + 1, n); continue;
    }
    if (c === '"' || c === "'") { blank(1); st.q = c; i++; continue; }
    if (c === '`') { blank(1); st.tmpl = true; i++; continue; }
    out += c; i++;
  }
  return out;
}

const isIdent = (ch) => /[A-Za-z0-9_$]/.test(ch);
// A `/` starts a regex literal only where a value may begin; after an operand it
// is division. Approximate but the only hazard is a regex hiding a quote.
const regexAllowed = (soFar) => {
  const t = soFar.replace(/\s+$/, '');
  if (!t) return true;
  const last = t[t.length - 1];
  return '(,=:[!&|?{};+-*%~^'.includes(last) || /(?:^|[=(,:[!&|?{};]\s*)$/.test(t);
};

// One left-to-right walk of a masked line. `stopAt` lets the caller process only
// the text BEFORE a skip column first, so a one-line `if (c) { skip }` attributes
// the skip to `c` and not to whatever frame the line's trailing `}` pops.
function scan(masked, raw, st, state, stopAt) {
  const end = stopAt == null ? masked.length : stopAt;
  for (let j = 0; j < end; j++) {
    const c = masked[j];

    if (state.acc !== null) {                 // inside an `if (` condition
      if (c === '(' || c === '[' || c === '{') state.accDepth++;
      else if (c === ')' || c === ']' || c === '}') state.accDepth--;
      if (c === ')' && state.accDepth === 0) {
        state.pendingCond = normalizeExpr(state.acc.join(''));
        state.acc = null;
      } else {
        state.acc.push(raw[j]);
      }
      continue;
    }

    if (c === '{') {
      let cond = null;
      if (state.pendingCond !== null) { cond = state.pendingCond; state.pendingCond = null; }
      else if (state.pendingElse) { cond = state.lastPoppedCond; state.pendingElse = false; }
      state.stack.push(cond);
      continue;
    }
    if (c === '}') {
      state.lastPoppedCond = state.stack.pop() ?? null;
      continue;
    }

    if (isIdent(c) && !isIdent(masked[j - 1] || '')) {
      let w = c;
      let k = j + 1;
      while (k < end && isIdent(masked[k])) { w += masked[k]; k++; }
      if (w === 'if') {
        let p = k;
        while (p < end && /\s/.test(masked[p])) p++;
        if (masked[p] === '(') { state.acc = []; state.accDepth = 1; j = p; continue; }
      } else if (w === 'else') {
        const rest = masked.slice(k, end);
        if (/^\s*if\b/.test(rest)) { /* handled by the `if` token itself */ }
        else if (/^\s*\{/.test(rest)) { state.pendingElse = true; }
      }
      j = k - 1;
    }
  }
}

/** Ordered skip sites: [{ line, guard }] — 1-based line numbers. */
export function extractSites(lines) {
  const sites = [];
  const st = { block: false, tmpl: false, q: null };
  const state = { stack: [], acc: null, accDepth: 0, pendingCond: null, pendingElse: false, lastPoppedCond: null };

  for (let li = 0; li < lines.length; li++) {
    const raw = lines[li];
    const m = maskLine(raw, st);
    const hit = SKIP_RE.exec(raw);
    if (!hit) { scan(m, raw, st, state, null); continue; }
    const col = hit.index;
    scan(m, raw, st, state, col);                    // everything before the skip
    sites.push({
      line: li + 1,
      guard: state.stack.length ? state.stack[state.stack.length - 1] : null,
    });
    scan(m, raw, st, state, m.length);               // the rest of the line
  }
  return sites;
}
