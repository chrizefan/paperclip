# source-anchor — pinning source `result.skipped += 1` sites onto a shipped build

DIG-2331. Third anchoring approach. Answers one question without ever guessing:

> given a source tree and any build of it, which `dist` line does each source
> `result.skipped += 1` site correspond to — and, when that cannot be determined,
> **which site refuses and why**.

The refusal shape is copied from `rearm-after-upgrade.mjs --check`: `FATAL: …`
lines and `exit 2`. No patch is emitted unless every site is placed.

## Why this exists

`paperclip-fixes/dig-2331/` — the previous deliverable, plus EM's
`EM-ANCHOR-RECIPE.md` and `leaf0-site-fingerprints.json` (the truth set DIG-2341
depends on) — **are gone.** Measured: the `paperclip-fixes` directory still
exists and still holds `dig-1874/`, `dig-2120/` and `dig-1346b/`, so the
deletion was **selective** and its cause is **unidentified** — I am not claiming
a sweep. The two loose files are not present in `paperclip-fixes`,
`paperclip-workspace`, `Code/digithings`, `Code/paperclip-dig1946` or this
worktree (bounded search; **not** a whole-filesystem claim).

Two recurrences of the same organisational problem — a durable artefact parked in
a directory that is not a durable home. Hence a repo with a remote.

## Layout

| file | role |
|---|---|
| `lib/extract.mjs` | structural extractor: every skip site + the text of the innermost enclosing `if` |
| `source-anchor.mjs` | the anchor CLI + all refusals |
| `probe-01-guard-histogram.mjs` | cross-tree guard histogram — the content proof |
| `probe-02-diagonal-control.mjs` | scores the naive diagonal (EM's "approach 4") |
| `probe-03-counterfactuals.mjs` | builds two mutated dist trees to find what is *not* caught |
| `PINNED_COMMIT` | `8f8a0ab7effbd6a0584107d8038736c134ee5047` |

## Method

1. Extract every `result.skipped += 1` from both trees, each carrying the text of
   the innermost enclosing `if` (the **guard**).
2. Bucket both sides by normalised guard text.
3. Inside a bucket, pair source occurrence *k* with dist occurrence *k*.

No line arithmetic and no constant offset. A line drift or neighbourhood churn
cannot move a placement; only a genuine edit to the same expression changes a
guard's text.

Each placement is labelled:

* **CONTENT** — the guard occurs exactly once on each side, so guard text alone
  picks this occurrence out.
* **ORDER** — the guard repeats, so only position within the group picks it. These
  are printed by `--ambiguous` and **must be confirmed by hand**.

## Run it

```sh
W=~/Code/wt-dig2331-anchor
SRC="$W/server/src/services/recovery/service.ts"
SAME=~/.paperclip/cli/current/node_modules/@paperclipai/server/dist/services/recovery/service.js

node "$W/scripts/dig2331/source-anchor.mjs" --source "$SRC" --dist "$SAME" [--ambiguous] [--json]
```

Against any other build, point `--dist` at it. Nothing here is destructive and
nothing touches the live tree — the tool only reads.

## What is checked, and what is deliberately NOT checked

Checked:

* **site count** — source vs dist `skipped` counts must be equal;
* **injectivity** — two different raw guards must not normalise to one key, in
  either tree (the bucket pairing would then be ambiguous in a way no count can
  reveal);
* **completeness** — every source site placed, every dist site either placed or
  reported as NEW with its guard text.

**Not checked, on purpose:** ordinal skew within a guard bucket. That invariant
existed here and was **deleted as tautological** — inside a bucket the pairing is
k-th to k-th, so both ordinals *are* `k` and the skew is zero by construction. A
guard that cannot fail is worse than no guard. `probe-03` measures the
consequence rather than pretending it away.

## Measurements

All six were re-run against the committed bytes. Numbers as measured.

### 1. Cross-tree guard histogram — the content proof

`probe-01` over source vs the installed dist: **65 sites on both sides, 35
distinct guard keys, and every one of the 35 buckets agrees on its count —
0 buckets disagree, 0 src-only keys, 0 dist-only keys.** Bucket sizes:
29 groups of 1, two of 2, one of 5, two of 6, one of 15.

That last line is the real proof, because it **independently reproduces the
split the anchor reports**: sites sitting in singleton guard buckets = **29**,
which is exactly the 29 placements the anchor labels CONTENT; the remaining
36 sites are the ones in the six repeating buckets, exactly matching its
`order-resolved : 36`. Two different instruments — one a census over buckets,
one a pairing — arrive at 29/36 from opposite directions.

### 2. Same build (installed `2026.1001.0`)

```
skip sites        : source 65 / dist 65
placements        : 65   dropped 0   new 0
content-proven    : 29   order-resolved : 36
EXIT=0
```

### 3. Bumped build (`2026.1005.0`, `npm pack` into scratch, **never installed**)

```
skip sites        : source 65 / dist 71
placements        : 61   dropped 4   new 10
content-proven    : 28   order-resolved : 33
EXIT=2 — 15 FATAL lines
```

This is the load-bearing result: against a build the source has never seen, the
tool names its own differences instead of producing a patch. Fifteen named
sites, including a real upstream **widening** on both halves:

```
FATAL: unplaced source site at line 3383: guard `requiresExecutionReconciliation(action.cause)`
       has 1 source occurrence(s) and 0 dist occurrence(s)
FATAL: unplaced dist site at line 2218: guard
       `requiresExecutionReconciliation(action.cause)||isNativeWorkspaceExportRepairCause(action.cause)||action.cause==="native_workspace_sync_out_unsafe_archive"`
       has no source partner at this build
```

One guard became three ORs upstream, so the source site drops and the dist site
is new. A line-offset patch would have silently mis-placed everything after it.

### 4. The naive diagonal is falsified (`probe-02`)

Scored on guard text, whole-file scope:

| dist | EXACT | WRONG |
|---|---|---|
| same build | 65 | 0 |
| bumped `2026.1005.0` | **6** | **59** |

59 of 65 wrong against a build four patch versions ahead. *(Labelled: whole-file
scope. An earlier 10-08 run scored 4/57 over a 61-site ladder scope — same
conclusion, different population, do not quote the two interchangeably.)*

### 5 & 6. Counterfactuals — what is caught and what is not (`probe-03`)

| mutation | result |
|---|---|
| (a) remove one skip site | **caught** — `EXIT=2`, 2 FATAL lines, names the unplaced source site |
| (b) remove `updated`#2, add into `updated`#10 (count 65=65, bucket 15=15) | **NOT caught** — `EXIT=0`, 65 placements |

(b) is the honest structural limit of this approach, measured rather than
asserted.

## The limit, stated plainly

**36 of 65 placements on the same build are order-resolved, not
content-proven.** Within a guard group of size > 1 the k-th↔k-th pairing is
forced and no independent signal exists to pick one occurrence out of the group;
counterfactual (b) shows the count invariants are blind to a substitution inside
a group. The tool therefore **says so** rather than over-claiming.

Closing that gap needs something outside this tool, and only two options were
found:

1. **per-build human confirmation** of the 36 (`--ambiguous` prints them), or
2. **an upstream per-branch marker** in source so each site carries its own
   identity through the build — a source change, owned upstream.

Both were raised and **neither is answered**. This is the open question on
DIG-2331.

## Acceptance criteria — verdicts

1. **Third approach measured on the 65 sites, numbers reported whatever they
   are.** ✅ Met. 65 / 29 content-proven / 36 order-resolved / `EXIT=0` on the
   same build; 61 / 28 / 33 / `EXIT=2` with 15 named refusals on a bumped build.
   The failure case is reported as the failure case.
2. **Re-derivable against a new published build without hand-assigning 12
   reason names, or a written statement that it is not achievable and why.**
   ✅ Met as written, with the limit stated above. 61 of 65 sites are
   self-naming across a build bump — the tool emits no site identities by hand.
   The residual 4 dropped + 10 new are all named *by the tool* from guard text.
   What is **not** achievable is 100% unassisted placement: 36 placements are
   positional and need one of the two options above.
3. **No change to the live Paperclip tree.** ✅ Met. Every measurement reads a
   staged copy; the bumped build lives only in the run scratch dir via
   `npm pack`; the live `dist` was never written.

## Correction to a claim of mine

On 2026-10-08 I recorded dist/source commit correspondence as an unverifiable
assumption. `GET /api/health` on the running board returns
`commit: 8f8a0ab7effbd6a0584107d8038736c134ee5047`, which matches
`serverInfo.git.fullSha` at the pinned source, and `PINNED_COMMIT` carries it.
The correspondence is **measured**, not assumed.

Also corrected: the 10-08 whole-file bumped figures were 60 matched / 5 dropped
/ 11 new; this anchor gives **61 / 4 / 10**, because the one site with a null
guard is now paired by order instead of counted as dropped-plus-new.

## Three extractor bugs hit while building this (all mine, all fixed)

Recorded because the same three will be re-hit otherwise:

1. `!isIdent(masked[j + 1])` after a keyword made every **multi-character**
   keyword (`if`, `else`) undetectable, so all 65 guards extracted as `null` —
   and the anchor then returned a **vacuous `OK`**: 65 sites bucketed into one
   `null` key, 65↔65, zero refusals. A green run that meant nothing.
2. A regex literal could hide a quote and corrupt the mask → `regexAllowed()`.
3. esbuild drops a trailing comma TypeScript keeps →
   `.replace(/,([)\]}])/g, '$1')`, inserted as a chain element (a stray `;`
   inside a chain expression breaks it).

`/bin/cat`/`/bin/ls` and `/opt/homebrew/bin/node` are the paths on this host;
`node` is 26.10.0 and `/usr/local/bin/npm` does not exist.