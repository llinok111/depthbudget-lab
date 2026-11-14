// tools/gen-sample.mjs — deterministic scene generator + baked reference metrics.
// Same command twice => byte-identical output (no randomness, no timestamps).
import { writeFileSync, mkdirSync } from 'node:fs';
import { analyzeScene, planRepair, summarize } from '../src/core.mjs';

const q = (cx, cy, z, w, h) => [
  [cx - w / 2, cy - h / 2, z], [cx + w / 2, cy - h / 2, z],
  [cx + w / 2, cy + h / 2, z], [cx - w / 2, cy + h / 2, z],
];
const ground = (x0, x1, y, z0, z1) => [[x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1]];
const tilted = (cx, cy, z, w, h, tilt) => {
  const out = [];
  for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const x = (sx * w) / 2;
    out.push([cx + x, cy + (sy * h) / 2 + x * tilt, z + x * tilt * 0.5]);
  }
  return out;
};

const camera = (pos, target) => ({ position: pos, target, up: [0, 1, 0], fovY: Math.PI / 3, aspect: 16 / 9, near: 0.1, far: 1000 });

export const scenes = [
  {
    id: 'facade-decals',
    camera: camera([0, 1.6, 4], [0, 1.6, -18]),
    surfaces: [
      { id: 'wall', points: q(0, 0, -18, 30, 18) },
      { id: 'win-a', points: q(-6, 2, -17.996, 4, 3) },
      { id: 'win-b', points: q(0, 2, -17.996, 4, 3) },
      { id: 'win-c', points: q(6, 2, -17.996, 4, 3) },
      { id: 'band', points: q(0, -4, -17.995, 26, 1.2) },
    ],
  },
  {
    id: 'road-markings',
    camera: camera([0, 2.2, 6], [0, 1.0, -20]),
    surfaces: [
      { id: 'asphalt', points: ground(-14, 14, -1.7, -4, -44) },
      { id: 'lane-a', points: ground(-4.2, -3.9, -1.6985, -5, -43) },
      { id: 'lane-b', points: ground(0.3, 0.6, -1.6985, -5, -43) },
      { id: 'stop-line', points: ground(-8, 8, -1.6975, -11.9, -11.5) },
    ],
  },
  {
    id: 'glass-panels',
    camera: camera([0, 1.5, 2], [0, 1.5, -6]),
    surfaces: [
      { id: 'pane-front', points: q(0, 0, -6.0, 6, 4) },
      { id: 'pane-back', points: q(0.6, 0.3, -6.0012, 6, 4) },
      { id: 'frame', points: q(0, 0, -5.99, 6.4, 4.4) },
    ],
  },
  {
    id: 'roof-panels',
    camera: camera([2, 6, 10], [0, 2, -60]),
    surfaces: [
      { id: 'roof-a', points: tilted(-8, 2, -60, 26, 12, 0.02) },
      { id: 'roof-b', points: tilted(6, 2.15, -60.008, 26, 12, 0.02) },
      { id: 'ridge', points: tilted(0, 8.2, -59.86, 40, 1.0, 0.0) },
    ],
  },
  {
    id: 'hud-overlay',
    camera: camera([0, 0, 0], [0, 0, -1]),
    surfaces: [
      { id: 'hud-bg', points: q(0, 0, -0.6, 1.1, 0.62) },
      { id: 'hud-ring', points: q(0.1, 0.02, -0.618, 0.5, 0.5) },
      { id: 'hud-label', points: q(0.1, -0.2, -0.6105, 0.7, 0.12) },
    ],
  },
  {
    id: 'far-facade',
    camera: camera([0, 0, 0], [0, 0, -250]),
    surfaces: [
      { id: 'tower', points: q(0, 0, -250, 60, 120) },
      { id: 'cladding', points: q(4, 10, -249.98, 30, 40) },
      { id: 'sign', points: q(-8, -20, -249.96, 18, 6) },
    ],
  },
];

const reference = {
  generatedBy: 'tools/gen-sample.mjs',
  scenes: scenes.map((s) => {
    const r24 = analyzeScene(s, { bits: 24 });
    const r16 = analyzeScene(s, { bits: 16 });
    const repair = planRepair(s, 24);
    return {
      scene: s.id,
      surfaces: s.surfaces.length,
      bits24: { overlappingPairs: r24.overlappingPairs, conflicts: r24.conflicts, minUnits: r24.minUnits },
      bits16: { conflicts: r16.conflicts, minUnits: r16.minUnits },
      tight: repair.tight,
      afterTight: { conflicts: repair.after.conflicts, minUnits: repair.after.minUnits },
      still: repair.still,
    };
  }),
};
reference.totals = {
  scenes: scenes.length,
  conflicts24: reference.scenes.reduce((a, b) => a + b.bits24.conflicts, 0),
  conflicts16: reference.scenes.reduce((a, b) => a + b.bits16.conflicts, 0),
  afterTight24: reference.scenes.reduce((a, b) => a + b.afterTight.conflicts, 0),
  overlappingPairs24: reference.scenes.reduce((a, b) => a + b.bits24.overlappingPairs, 0),
};

mkdirSync(new URL('../data/', import.meta.url), { recursive: true });
writeFileSync(new URL('../data/scenes.json', import.meta.url), JSON.stringify({ scenes }, null, 2) + '\n');
writeFileSync(new URL('../data/reference.json', import.meta.url), JSON.stringify(reference, null, 2) + '\n');
console.log(JSON.stringify(reference.totals));
console.log(summarize(scenes.map((s) => analyzeScene(s, { bits: 24 }))));
