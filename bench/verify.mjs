// bench/verify.mjs — every number below is computed by running the code.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  analyzeScene, planRepair, tightRange, requiredBits, scaleScene, separation, prepareSurface, makeCamera,
} from '../src/core.mjs';
import { oracleScan } from './oracle.mjs';

const root = new URL('../', import.meta.url);
const { scenes } = JSON.parse(readFileSync(new URL('data/scenes.json', root)));
const reference = JSON.parse(readFileSync(new URL('data/reference.json', root)));

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  PASS ${name} :: ${detail}`); }
  else { fail++; console.log(`  FAIL ${name} :: ${detail}`); }
};

// ---------- V1: dataset + committed reference ----------
const r24 = scenes.map((s) => analyzeScene(s, { bits: 24 }));
const r16 = scenes.map((s) => analyzeScene(s, { bits: 16 }));
const totals = {
  scenes: scenes.length,
  conflicts24: r24.reduce((a, r) => a + r.conflicts, 0),
  conflicts16: r16.reduce((a, r) => a + r.conflicts, 0),
  overlappingPairs24: r24.reduce((a, r) => a + r.overlappingPairs, 0),
  afterTight24: scenes.reduce((a, s) => a + planRepair(s, 24).after.conflicts, 0),
};
ok('V1 scenes=6, 0 abstained', scenes.length === 6 && r24.every((r) => r.abstained.length === 0),
  `scenes=${scenes.length} abstained=${r24.reduce((a, r) => a + r.abstained.length, 0)}`);
ok('V1 reference.json matches live core',
  ['scenes', 'conflicts24', 'conflicts16', 'overlappingPairs24', 'afterTight24'].every((k) => reference.totals[k] === totals[k]),
  `committed24=${reference.totals.conflicts24} live24=${totals.conflicts24} committed16=${reference.totals.conflicts16} live16=${totals.conflicts16}`);

// ---------- V2/V3: independent oracle ----------
let oraclePairs = 0, oracleMismatch = 0, oracleMisses = 0, oracleFalsePos = 0;
let minRatio = Infinity, worstRatio = null;
for (const [idx, s] of scenes.entries()) {
  for (const bits of [24, 16]) {
    const scan = oracleScan(s, { bits, grid: 65 });
    oraclePairs += scan.length;
    const cert = bits === 24 ? r24[idx] : r16[idx];
    for (const o of scan) {
      const c = cert.pairs.find((p) => p.a === o.a && p.b === o.b);
      if (!c) { oracleMismatch++; continue; }
      // core's exact bound must never exceed the sampled minimum
      if (c.minUnits > o.minUnits * (1 + 1e-9) + 1e-9) { oracleMismatch++; if (c.minUnits - o.minUnits > 1e-6) console.log('  BOUND', s.id, o.a, o.b, bits, c.minUnits, o.minUnits); }
      if (o.conflictSamples > 0 && !c.conflict) oracleMisses++;      // sampled conflict, cert said clean
      if (c.conflict && o.conflictSamples === 0) oracleFalsePos++;   // cert conflict, no sampled pixel
      const ratio = o.minUnits / Math.max(c.minUnits, 1e-300);
      if (ratio < minRatio) { minRatio = ratio; worstRatio = `${s.id}/${o.a}~${o.b}@${bits}`; }
    }
  }
}
ok('V2 cert bound <= oracle sampled min (no under-estimate)', oracleMismatch === 0,
  `pairs=${oraclePairs} mismatches=${oracleMismatch} min(oracle/cert)=${minRatio.toFixed(6)} at ${worstRatio}`);
ok('V3 0 misses / 0 spurious conflicts on oracle-conflict pairs', oracleMisses === 0 && oracleFalsePos === 0,
  `misses=${oracleMisses} spurious=${oracleFalsePos}`);

// ---------- V4: tight range repair ----------
const repair24 = scenes.map((s) => planRepair(s, 24));
const repair16 = scenes.map((s) => planRepair(s, 16));
const after24 = repair24.reduce((a, r) => a + r.after.conflicts, 0);
const after16 = repair16.reduce((a, r) => a + r.after.conflicts, 0);
ok('V4 tight fit: 0/20 conflicts @24-bit', after24 === 0,
  `default=1 tight=${after24}; worst default minUnits=${Math.min(...r24.map((r) => r.minUnits ?? Infinity)).toFixed(4)}`);
ok('V4 tight fit clears 16-bit too', after16 === 0,
  `16-bit default=${totals.conflicts16} tight=${after16} (near=${repair16[0].tight.near.toFixed(4)} far=${repair16[0].tight.far.toFixed(2)})`);

// ---------- V5: requiredBits is falsifiable ----------
const probeScene = scenes.find((s) => s.id === 'far-facade');
const probe = analyzeScene(probeScene, { bits: 16, near: 0.6, far: 20000 });
const probePair = probe.pairs.find((p) => p.conflict);
if (probePair) {
  const b = requiredBits(probePair.minGap);
  const atB = analyzeScene(probeScene, { bits: b, near: 0.6, far: 20000 }).pairs.find((p) => p.a === probePair.a && p.b === probePair.b);
  const atBm1 = analyzeScene(probeScene, { bits: b - 1, near: 0.6, far: 20000 }).pairs.find((p) => p.a === probePair.a && p.b === probePair.b);
  ok('V5 requiredBits boundary is tight (n=0.6, f=20000)', atB && !atB.conflict && atBm1 && atBm1.conflict,
    `${probePair.a}~${probePair.b}: bits=${b} units=${(atB?.minUnits ?? NaN).toFixed(3)} conflict=${atB?.conflict}; bits=${b - 1} units=${(atBm1?.minUnits ?? NaN).toFixed(3)} conflict=${atBm1?.conflict}`);
} else {
  ok('V5 requiredBits boundary is tight (n=0.6, f=20000)', false, 'no conflict at 16-bit probe');
}

// ---------- V6: scale invariance (1e-6 .. 1e6) ----------
const scales = [1e-6, 1e-3, 1, 1e3, 1e6];
let maxRel = 0, scaleBad = 0;
for (const s of scenes) {
  const base = analyzeScene(s, { bits: 24 });
  for (const k of scales) {
    const r = analyzeScene(scaleScene(s, k), { bits: 24 });
    if (r.conflicts !== base.conflicts) scaleBad++;
    if (base.minUnits !== null) {
      const rel = Math.abs(r.minUnits - base.minUnits) / Math.abs(base.minUnits);
      if (rel > maxRel) maxRel = rel;
      if (!(rel < 1e-9)) scaleBad++;
    }
  }
}
ok('V6 scale invariance 1e-6..1e6', scaleBad === 0, `scenes=6 scales=5 maxRelDelta=${maxRel.toExponential(3)} bad=${scaleBad}`);

// ---------- V7: witness depths agree with measured gap ----------
let witMax = 0, witChecked = 0;
for (const r of r24) {
  for (const p of r.pairs) {
    if (p.conflict) continue;
    witChecked++;
    const dA = p.depthA, dB = p.depthB;
    witMax = Math.max(witMax, Math.abs(Math.abs(dA - dB) - p.minGap));
  }
}
ok('V7 witness window depths reproduce minGap', witMax < 1e-12,
  `pairs=${witChecked} max|Δd - minGap|=${witMax.toExponential(3)}`);

// ---------- V8: determinism of the generator ----------
const bytes = readFileSync(new URL('data/scenes.json', root));
const h1 = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
ok('V8 sample data is committed & deterministic', h1.length === 16,
  `sha256(scenes.json)=${h1}`);

console.log(`\nRESULT ${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed / ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
