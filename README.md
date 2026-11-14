# depthbudget-lab — exact z-fighting budget for WebGL scenes

**One-line promise:** predict depth-buffer z-fighting *exactly* instead of sampling it — on the 6 committed
scenes the certificate decides all 20 screen-overlapping pairs in **0.462 ms median** (cold 3.400 ms) versus
**30.297 ms** for a 129×129 ray/plane sampling baseline (cold 69.384 ms) — **65.6× faster** — while keeping
the sampled oracle's verdicts **20/20**, and it repairs all 15 16-bit conflicts (1 at 24-bit) to **0** by
tightening near/far to the scene bounds; the required bit depth is checked by falling back one bit and
watching the same pair fail again.

Upstream: none

## Why the answer is exact, not sampled

For a planar surface, `w = 1/z_eye` is an **affine** function of NDC `(x, y)`; window depth
`d = f/(f−n)·(1 − n·w)` is therefore affine too, so the signed gap between two surfaces is affine over their
convex screen-space overlap. An affine function attains its extremes at a polygon vertex, and its absolute
value attains zero where it changes sign. Both cases are computed in closed form from a clipped overlap
polygon — no grid, no epsilon on the verdict. The only absolute constant in `src/core.mjs` is `EPS = 1e-12`,
used **solely** to reject degenerate projections (a surface behind the camera or three collinear vertices);
it never enters a depth decision. One quantum is the stated spec value `1/(2^bits − 1)`.

## How to run

```bash
node --version                 # v24.x
node tools/gen-sample.mjs      # rebuild data/ deterministically (fixed scenes, no RNG)
node bench/verify.mjs          # 10 assertions, exits 0 only if all pass
node bench/bench.mjs           # 7 repeats + cold start -> bench/result.json
python3 -m http.server 4173     # then open http://localhost:4173  (three r0.160.0 via pinned importmap)
```

The page fetches `data/scenes.json`, re-runs the **same** `src/core.mjs` in the browser for the current
near/far and bit depth, and shows the node-baked `data/reference.json` values next to it. Press `T` to jump to
the tight scene range; drag near/far and watch the conflict count move against the committed numbers.

## Evidence (real run, `bench/result.json`)

| claim | measured | baseline / check |
|---|---|---|
| decision cost, 6 scenes / 20 pairs | **0.462 ms** median, cold **3.400 ms** | 129×129 sampling **30.297 ms** median, cold 69.384 ms → **65.6×** |
| verdict correctness | **20/20 agree**, 0 disagreements | independent ray/plane oracle, own camera + own point-in-polygon code |
| conflicts at default near/far | **1** (24-bit), **15** (16-bit) | exact certificate over all overlaps |
| after tight near/far | **0** (24-bit), **0** (16-bit) | tight range from scene geometry |
| `requiredBits` boundary | bits **23** clean (1.611 q), bits **22** fails (0.805 q) | same pair, same range, one bit apart |
| scale invariance 1e-6 … 1e6 | max relative drift **2.05e-12** | 6 scenes × 5 scales, conflict counts identical |
| witness consistency | max `|Δd − minGap|` **1.40e-16** | 19 clean pairs, witness window depths |

`node bench/verify.mjs` → `RESULT PASS: 10 passed / 0 failed` (exit 0).
Relative stddev of the certificate is **39.9%** because the whole pipeline is sub-millisecond: JIT warm-up
and GC dominate, so the cold run (3.4 ms) is reported separately and the median is the stable figure.
The sampling baseline's relative stddev is 21.5%.

## 本轮创新

**New:** an exact, closed-form depth-separation certificate over clipped screen-space overlaps plus a
*repair* that says how many bits and which far plane are needed — the sample-based tooling in this space
(Babylon/three debug overlays, "z-fighting" heuristics) only shows fighting after it happens, and depth
precision articles give per-pixel formulas but never a scene-wide verdict with a witness. Here every
"pair is clean" statement is an exact bound (oracle-checked 20/20) and every "pair fights" statement carries
the NDC point and both window depths. Nothing in the ledger covers depth precision.

## Known limitations (read before trusting a number)

- **Geometry model:** planar convex quads only; surfaces crossing the near plane abstain instead of guessing.
- **Verdict definition:** "conflict" means the exact minimum gap is **< 1 quantum** at the chosen bit depth.
  That is the standard z-fighting criterion, but it is not the same as the quantized integers colliding at
  every pixel; a gap just above 1 quantum may still round-collide on some pixels. Both quantities are
  reported (`minUnits`, and the witness depths) so the distinction is auditable.
- **Scale range:** tested 1e-6 … 1e6 with camera and near/far scaled together; outside that, float error in
  the clipped polygon vertices grows. Absolute thresholds are: `EPS = 1e-12` (degeneracy only), overlap area
  floor `1e-12` in NDC², and oracle bound tolerance `1e-9` relative.
- **No rendering claims:** depth is computed analytically, not read from a GPU; MSAA, reversed-Z, logarithmic
  depth and per-sample depth are out of scope. The browser page visualises the same math, it does not probe
  the driver.
- **Repair scope:** near/far placement only. If `requiredBits` exceeds 32 for a pair, the tool says so rather
  than pretending that geometry offsets or reversed-Z were tested.

## Layout

```
index.html · main.js        browser view (three r0.160.0, pinned importmap); consumes core only
src/core.mjs                pure math: projection, affine 1/z fit, clipping, exact separation, repair
tools/gen-sample.mjs        deterministic 6-scene generator + baked reference
bench/verify.mjs           10 assertions incl. independent oracle and scale invariance
bench/oracle.mjs           independent ray/plane + point-in-polygon sampler (no shared code/constants)
bench/bench.mjs            timings -> bench/result.json
data/                      generated scenes + reference (committed, small, reproducible)
```
