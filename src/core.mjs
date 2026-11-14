// src/core.mjs — depth-buffer precision budget, pure math.
// No three.js, no DOM, no I/O, no globals. Runs identically in node and the browser.
//
// Model. A camera at C looking at T, up U, vertical fov fovY, aspect a.
// Eye space: x right, y up, z forward-distance (positive in front of camera).
//   tanY = tan(fovY/2)
//   ndc.x = (x/z) / (tanY*a)      ndc.y = (y/z) / tanY
// For a plane, w = 1/z is an *affine* function of (ndc.x, ndc.y):
//   w = A*ndc.x + B*ndc.y + C
// Screen depth for near n, far f is
//   d = f/(f-n) * (1 - n*w)
// so the signed depth gap between two planes is affine too. Over a convex
// screen-space overlap polygon an affine function attains its extremes at a
// vertex (or at its zero crossing), which makes the separation bound exact
// rather than sampled. That exactness is the whole point of this repo.

const EPS = 1e-12; // only used for degeneracy tests, never for depth verdicts

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => { const l = len(a); return l > EPS ? [a[0] / l, a[1] / l, a[2] / l] : null; };
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

export function makeCamera({ position, target, up = [0, 1, 0], fovY = Math.PI / 3, aspect = 16 / 9, near = 0.1, far = 1000 }) {
  const fwd = unit(sub(target, position));
  const upv = unit(up);
  if (!fwd || !upv) throw new Error('camera: degenerate position/target/up');
  const right = unit(cross(fwd, upv));
  if (!right) throw new Error('camera: up parallel to view direction');
  const up2 = cross(right, fwd);
  return {
    position, target, up, fovY, aspect, near, far,
    fwd, right, up2,
    tanY: Math.tan(fovY / 2),
  };
}

/** World point -> eye space {x,y,z}; z is positive distance in front. */
export function toEye(cam, p) {
  const d = sub(p, cam.position);
  return { x: dot(d, cam.right), y: dot(d, cam.up2), z: dot(d, cam.fwd) };
}

/** World point -> NDC, or null when not strictly in front of the camera. */
export function project(cam, p) {
  const e = toEye(cam, p);
  if (!(e.z > EPS)) return null;
  return { x: e.x / (e.z * cam.tanY * cam.aspect), y: e.y / (e.z * cam.tanY), z: e.z };
}

/** Screen depth in [0,1] for an eye distance z under (near, far). */
export function depthAt(z, near, far) {
  if (!(z > 0) || !(far > near)) throw new Error('depthAt: bad range');
  return (far / (far - near)) * (1 - near / z);
}

/** Bring a planar quad into the analysis frame: NDC polygon + affine w. */
export function prepareSurface(cam, quad) {
  if (!Array.isArray(quad) || quad.length < 3) return { ok: false, reason: 'fewer-than-3-vertices' };
  const eye = quad.map((p) => toEye(cam, p));
  if (eye.some((e) => !(e.z > EPS))) return { ok: false, reason: 'behind-camera' };
  const ndc = eye.map((e) => ({ x: e.x / (e.z * cam.tanY * cam.aspect), y: e.y / (e.z * cam.tanY), w: 1 / e.z }));

  // Solve w = A*x + B*y + C from three non-collinear projected vertices.
  let A = null, B = null, C = null;
  for (let i = 0; i < ndc.length && A === null; i++) {
    for (let j = i + 1; j < ndc.length && A === null; j++) {
      for (let k = j + 1; k < ndc.length && A === null; k++) {
        const p = ndc[i], q = ndc[j], r = ndc[k];
        const det = (q.x - p.x) * (r.y - p.y) - (r.x - p.x) * (q.y - p.y);
        if (Math.abs(det) < 1e-14) continue;
        const dw1 = q.w - p.w, dw2 = r.w - p.w;
        B = (dw2 * (q.x - p.x) - dw1 * (r.x - p.x)) / det;
        A = (dw1 * (r.y - p.y) - dw2 * (q.y - p.y)) / det;
        C = p.w - A * p.x - B * p.y;
      }
    }
  }
  if (A === null) return { ok: false, reason: 'degenerate-projection' };

  // Planarity/affinity check on every vertex (exact up to float noise).
  let maxResidual = 0;
  for (const p of ndc) maxResidual = Math.max(maxResidual, Math.abs(A * p.x + B * p.y + C - p.w));
  const scale = Math.max(1, Math.abs(C));
  if (!(maxResidual < 1e-9 * scale)) return { ok: false, reason: 'non-planar-quad' };

  const poly = ndc.map((p) => [p.x, p.y]);
  return { ok: true, poly, A, B, C, eyeZ: eye.map((e) => e.z), maxResidual };
}

function signedArea(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    s += p[0] * q[1] - q[0] * p[1];
  }
  return s / 2;
}

function ccw(poly) {
  return signedArea(poly) < 0 ? poly.slice().reverse() : poly;
}

function clipHalfPlane(poly, a, b) {
  // keep points with cross(b-a, p-a) >= 0  (left of directed edge a->b)
  const out = [];
  const side = (p) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const sp = side(p), sq = side(q);
    if (sp >= 0) out.push(p);
    if ((sp > 0 && sq < 0) || (sp < 0 && sq > 0)) {
      const t = sp / (sp - sq);
      out.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]);
    }
  }
  return out;
}

/** Screen-space overlap of two convex NDC polygons, clipped to the viewport. */
export function overlapPolygon(polyA, polyB) {
  let a = ccw(polyA);
  let b = ccw(polyB);
  const viewport = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  for (const [p, q] of [[viewport[0], viewport[1]], [viewport[1], viewport[2]], [viewport[2], viewport[3]], [viewport[3], viewport[0]]]) {
    a = clipHalfPlane(a, p, q);
    b = clipHalfPlane(b, p, q);
    if (a.length < 3 || b.length < 3) return null;
  }
  let out = a;
  for (let i = 0; i < b.length && out.length >= 3; i++) {
    out = clipHalfPlane(out, b[i], b[(i + 1) % b.length]);
  }
  return out.length >= 3 ? out : null;
}

export function polygonArea(poly) {
  return Math.abs(signedArea(poly));
}

/**
 * Exact signed separation between two prepared surfaces over their overlap.
 * Returns depth gap in *window-depth units* (1 unit = one quantum at `bits`).
 */
export function separation(sa, sb, near, far, bits) {
  const alpha = (near * far) / (far - near); // d = far/(far-near) - alpha * w
  const q = 1 / (2 ** bits - 1);
  const poly = overlapPolygon(sa.poly, sb.poly);
  if (!poly) return { overlap: false };

  const dw = { A: sa.A - sb.A, B: sa.B - sb.B, C: sa.C - sb.C };
  const at = (p) => -alpha * (dw.A * p[0] + dw.B * p[1] + dw.C);
  const vals = poly.map(at);
  let minV = Infinity, maxV = -Infinity;
  for (const v of vals) { if (v < minV) minV = v; if (v > maxV) maxV = v; }

  let minAbs = Math.min(Math.abs(minV), Math.abs(maxV));
  let witness = null;
  if (minV < 0 && maxV > 0) {
    minAbs = 0;
    for (let i = 0; i < poly.length && !witness; i++) {
      const j = (i + 1) % poly.length;
      const v1 = vals[i], v2 = vals[j];
      if ((v1 <= 0 && v2 >= 0) || (v1 >= 0 && v2 <= 0)) {
        const t = Math.abs(v1) + Math.abs(v2) > 0 ? Math.abs(v1) / (Math.abs(v1) + Math.abs(v2)) : 0;
        witness = [poly[i][0] + t * (poly[j][0] - poly[i][0]), poly[i][1] + t * (poly[j][1] - poly[i][1])];
      }
    }
    if (!witness) witness = poly[0];
  } else {
    const idx = Math.abs(minV) <= Math.abs(maxV) ? vals.indexOf(minV) : vals.indexOf(maxV);
    witness = poly[idx];
  }

  const minUnits = (minAbs / q);
  return {
    overlap: true,
    area: polygonArea(poly),
    minGap: minAbs,          // in normalized screen depth
    minUnits,                // in quanta
    maxUnits: (Math.max(Math.abs(minV), Math.abs(maxV)) / q),
    conflict: minUnits < 1,
    witness,
    depthA: depthAt(1 / (sa.A * witness[0] + sa.B * witness[1] + sa.C), near, far),
    depthB: depthAt(1 / (sb.A * witness[0] + sb.B * witness[1] + sb.C), near, far),
  };
}

/** Analyse one scene. near/far override the camera's own range when given. */
export function analyzeScene(scene, { bits = 24, near = null, far = null } = {}) {
  const cam = makeCamera(scene.camera);
  const prepared = scene.surfaces.map((s) => ({ id: s.id, ...prepareSurface(cam, s.points) }));
  const n = near ?? scene.camera.near ?? 0.1;
  const f = far ?? scene.camera.far ?? 1000;
  const pairs = [];
  const abstained = prepared.filter((p) => !p.ok).map((p) => ({ id: p.id, reason: p.reason }));
  const live = prepared.filter((p) => p.ok);

  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const sep = separation(live[i], live[j], n, f, bits);
      if (!sep.overlap || sep.area < 1e-12) continue;
      pairs.push({ a: live[i].id, b: live[j].id, ...sep });
    }
  }
  const conflicts = pairs.filter((p) => p.conflict);
  const minUnits = pairs.length ? Math.min(...pairs.map((p) => p.minUnits)) : null;
  return {
    scene: scene.id, bits, near: n, far: f,
    surfaces: scene.surfaces.length,
    pairsChecked: (live.length * (live.length - 1)) / 2,
    overlappingPairs: pairs.length,
    conflicts: conflicts.length,
    abstained,
    minUnits,
    pairs,
  };
}

/** Tight scene range: near = closest geometry, far = farthest. */
export function tightRange(scene) {
  const cam = makeCamera(scene.camera);
  let minZ = Infinity, maxZ = -Infinity;
  for (const s of scene.surfaces) for (const p of s.points) {
    const e = toEye(cam, p);
    if (e.z < minZ) minZ = e.z;
    if (e.z > maxZ) maxZ = e.z;
  }
  return { near: minZ * 0.999, far: maxZ * 1.001, minZ, maxZ };
}

/**
 * Minimal far plane that lifts a pair of given screen-space depth slope |dw|
 * above one quantum, for a fixed near. f = q*n / (q - n*|dw|), valid only while
 * n*|dw| < q (otherwise even an infinite far plane cannot separate them).
 */
export function requiredFar(dwAbs, near, bits) {
  const q = 1 / (2 ** bits - 1);
  const denom = q - near * dwAbs;
  if (!(dwAbs > 0) || denom <= 0) return { feasible: false, limit: q / near };
  return { feasible: true, far: (q * near) / denom };
}

/** Bits needed for a pair whose exact minimum |Δd| is known (near/far fixed). */
export function requiredBits(minGap) {
  if (!(minGap > 0)) return Infinity;
  return Math.ceil(Math.log2(1 / minGap + 1));
}

/** Repair plan: tighten near/far to the scene bounds, then re-measure. */
export function planRepair(scene, bits = 24) {
  const before = analyzeScene(scene, { bits });
  const tight = tightRange(scene);
  const after = analyzeScene(scene, { bits, near: tight.near, far: tight.far });
  const still = after.pairs.filter((p) => p.conflict).map((p) => {
    const dwAbs = p.minGap / ((tight.near * tight.far) / (tight.far - tight.near));
    return { a: p.a, b: p.b, minUnits: p.minUnits, requiredBits: requiredBits(p.minGap), requiredFarTight: requiredFar(dwAbs, tight.near, bits) };
  });
  return { before, tight, after, still };
}

/** Deterministic scale of a whole scene, camera included (for scale-invariance proof). */
export function scaleScene(scene, s) {
  const mul = (p) => p.map((v) => v * s);
  return {
    id: `${scene.id}@${s}`,
    camera: { ...scene.camera, position: mul(scene.camera.position), target: mul(scene.camera.target), near: scene.camera.near * s, far: scene.camera.far * s },
    surfaces: scene.surfaces.map((x) => ({ id: x.id, points: x.points.map(mul) })),
  };
}

export function summarize(results) {
  return results.map((r) => ({
    scene: r.scene, bits: r.bits, near: r.near, far: r.far,
    overlappingPairs: r.overlappingPairs, conflicts: r.conflicts,
    minUnits: r.minUnits, abstained: r.abstained.length,
  }));
}
