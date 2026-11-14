// bench/bench.mjs — real timings, 7 repeats + cold start, median/p95/stddev.
import { performance } from 'node:perf_hooks';
import { readFileSync, writeFileSync } from 'node:fs';
import { analyzeScene } from '../src/core.mjs';
import { oracleScan } from './oracle.mjs';

const root = new URL('../', import.meta.url);
const { scenes } = JSON.parse(readFileSync(new URL('data/scenes.json', root)));

const stat = (xs) => {
  const s = xs.slice().sort((a, b) => a - b);
  const med = s[Math.floor(s.length / 2)];
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  const sd = Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / s.length);
  return {
    min: s[0], median: med, p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))],
    max: s[s.length - 1], mean, stddev: sd, relStddev: sd / mean,
  };
};

const certRun = () => scenes.map((s) => analyzeScene(s, { bits: 24 }));
const sampleRun = () => scenes.map((s) => oracleScan(s, { bits: 24, grid: 128 }));

// cold start (first touch of the modules / JIT)
let t0 = performance.now();
const coldCert = certRun();
const coldCertMs = performance.now() - t0;
t0 = performance.now();
const coldSample = sampleRun();
const coldSampleMs = performance.now() - t0;

const certMs = [], sampleMs = [];
for (let i = 0; i < 7; i++) {
  t0 = performance.now(); certRun(); certMs.push(performance.now() - t0);
  t0 = performance.now(); sampleRun(); sampleMs.push(performance.now() - t0);
}

const certConf = coldCert.reduce((a, r) => a + r.conflicts, 0);
const certPairs = coldCert.reduce((a, r) => a + r.overlappingPairs, 0);
const flatSample = coldSample.flat();
const sampledPairs = flatSample.length;
const sampledConfPairs = flatSample.filter((p) => p.conflictSamples > 0).length;

// Verdict comparison between the two independent engines, pair by pair.
let agree = 0, disagree = 0, missed = 0;
for (const [i, scene] of scenes.entries()) {
  for (const p of coldCert[i].pairs) {
    const o = flatSample.find((x) => x.a === p.a && x.b === p.b);
    if (!o) continue;
    const oConflict = o.conflictSamples > 0;
    if (oConflict === p.conflict) agree++;
    else { disagree++; if (p.conflict && !oConflict) missed++; }
  }
}

const result = {
  generatedBy: 'bench/bench.mjs',
  node: process.version,
  scenes: scenes.length,
  bits: 24,
  samples: 7,
  overlapPairs: certPairs,
  conflicts: certConf,
  certificate: { coldMs: coldCertMs, ...stat(certMs) },
  samplingBaseline: {
    coldMs: coldSampleMs, ...stat(sampleMs),
    grid: 128, sampledPairs, sampledConflicts: sampledConfPairs,
  },
  verdictAgreement: { agree, disagree, sampledMissedConflicts: missed },
  notes: [
    'certificate = exact affine 1/z separation over clipped overlap polygons (src/core.mjs)',
    'samplingBaseline = 129x129 ray/plane samples per pair (bench/oracle.mjs), independent code path',
    'a sampled baseline can only miss conflicts, never invent them; misses are reported, not hidden',
  ],
};

writeFileSync(new URL('bench/result.json', root), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({
  cert: { cold: +coldCertMs.toFixed(3), median: +result.certificate.median.toFixed(3), relStddev: +result.certificate.relStddev.toFixed(3) },
  sample: { cold: +coldSampleMs.toFixed(3), median: +result.samplingBaseline.median.toFixed(3), relStddev: +result.samplingBaseline.relStddev.toFixed(3) },
  speedup: +(result.samplingBaseline.median / result.certificate.median).toFixed(2),
  conflicts: certConf, pairs: certPairs, agreement: result.verdictAgreement,
}, null, 1));
