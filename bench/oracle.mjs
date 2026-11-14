// bench/oracle.mjs — independent depth-separation oracle.
// Deliberately shares NO code and NO constants with src/core.mjs:
//   * own camera basis, own projection, own point-in-convex-polygon test
//   * eye depth via ray/plane intersection (core solves an affine 1/z fit)
//   * the only shared quantity is the definition of one quantum, 1/(2^bits-1).
export function oracleEye(camera, p) {
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (a) => { const l = Math.hypot(...a); return [a[0] / l, a[1] / l, a[2] / l]; };
  const f = norm(sub(camera.target, camera.position));
  const r = norm(cross(f, camera.up));
  const u = cross(r, f);
  const d = sub(p, camera.position);
  return { x: dot(d, r), y: dot(d, u), z: dot(d, f) };
}

function signedArea(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s;
}

function insideConvex(poly, x, y) {
  const orient = signedArea(poly) >= 0 ? 1 : -1;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const c = orient * ((b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x));
    if (c < 0) return false;
  }
  return true;
}

function planeOf(eyePts) {
  const sub = (a, b) => [a.x - b.x, a.y - b.y, a.z - b.z];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const n = cross(sub(eyePts[1], eyePts[0]), sub(eyePts[2], eyePts[0]));
  return { n, p0: eyePts[0] };
}

/** Eye depth of the plane at the ray through NDC (X,Y); null if parallel/behind. */
function planeDepthAt(plane, X, Y, cam) {
  const ty = Math.tan(cam.fovY / 2);
  const dir = [X * ty * cam.aspect, Y * ty, 1];
  const denom = plane.n[0] * dir[0] + plane.n[1] * dir[1] + plane.n[2] * dir[2];
  if (Math.abs(denom) < 1e-18) return null;
  const t = (plane.n[0] * plane.p0.x + plane.n[1] * plane.p0.y + plane.n[2] * plane.p0.z) / denom;
  return t > 0 ? t : null;
}

/**
 * Brute-force grid check of every screen-overlapping surface pair.
 * Returns per-pair sampled minimum separation in quanta and conflict sample count.
 */
export function oracleScan(scene, { bits = 24, near = null, far = null, grid = 65 } = {}) {
  const cam = scene.camera;
  const n = near ?? cam.near, f = far ?? cam.far;
  const q = 1 / (2 ** bits - 1);
  const prep = scene.surfaces.map((s) => {
    const eye = s.points.map((p) => oracleEye(cam, p));
    const ty = Math.tan(cam.fovY / 2);
    const ndc = eye.map((e) => ({ x: e.x / (e.z * ty * cam.aspect), y: e.y / (e.z * ty) }));
    const okAll = eye.every((e) => e.z > 1e-12);
    return { id: s.id, eye, ndc, plane: planeOf(eye), okAll };
  });
  const out = [];
  for (let i = 0; i < prep.length; i++) {
    for (let j = i + 1; j < prep.length; j++) {
      const A = prep[i], B = prep[j];
      if (!A.okAll || !B.okAll) continue;
      const xs = A.ndc.concat(B.ndc).map((p) => p.x);
      const ys = A.ndc.concat(B.ndc).map((p) => p.y);
      const x0 = Math.max(-1, Math.min(...xs)), x1 = Math.min(1, Math.max(...xs));
      const y0 = Math.max(-1, Math.min(...ys)), y1 = Math.min(1, Math.max(...ys));
      if (x1 <= x0 || y1 <= y0) continue;
      let minUnits = Infinity, conflictSamples = 0, inside = 0, worst = null;
      for (let a = 0; a <= grid; a++) {
        for (let b = 0; b <= grid; b++) {
          const X = x0 + ((x1 - x0) * a) / grid;
          const Y = y0 + ((y1 - y0) * b) / grid;
          if (!insideConvex(A.ndc, X, Y) || !insideConvex(B.ndc, X, Y)) continue;
          const za = planeDepthAt(A.plane, X, Y, cam);
          const zb = planeDepthAt(B.plane, X, Y, cam);
          if (za === null || zb === null) continue;
          inside++;
          const da = (f / (f - n)) * (1 - n / za);
          const db = (f / (f - n)) * (1 - n / zb);
          const units = Math.abs(da - db) / q;
          if (units < minUnits) { minUnits = units; worst = { X, Y, za, zb }; }
          if (units < 1) conflictSamples++;
        }
      }
      if (inside > 0) out.push({ a: A.id, b: B.id, samples: inside, minUnits, conflictSamples, worst });
    }
  }
  return out;
}
