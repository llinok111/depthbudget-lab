// main.js — rendering + interaction only. All depth math comes from src/core.mjs.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { analyzeScene, tightRange, makeCamera } from './src/core.mjs';

const view = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(view.clientWidth, view.clientHeight);
view.appendChild(renderer.domElement);

const scene3 = new THREE.Scene();
scene3.background = new THREE.Color(0x0b0e14);
const camera3 = new THREE.PerspectiveCamera(60, view.clientWidth / view.clientHeight, 0.1, 1000);
const controls = new OrbitControls(camera3, renderer.domElement);
scene3.add(new THREE.HemisphereLight(0xffffff, 0x223344, 1.1));
const dir = new THREE.DirectionalLight(0xffffff, 0.9); dir.position.set(3, 6, 4); scene3.add(dir);

const data = await (await fetch('./data/scenes.json')).json();
const reference = await (await fetch('./data/reference.json')).json();
const scenes = data.scenes;
let current = scenes[0];

const $ = (id) => document.getElementById(id);
const sel = $('scene');
scenes.forEach((s, i) => { const o = document.createElement('option'); o.value = String(i); o.textContent = s.id; sel.appendChild(o); });

const group = new THREE.Group(); scene3.add(group);
const nearInput = $('near'), farInput = $('far');

function toThree(p) { return new THREE.Vector3(p[0], p[1], p[2]); }

function build() {
  group.clear();
  const cam = makeCamera(current.camera);
  camera3.position.copy(toThree(current.camera.position));
  // look along the scene camera's forward direction
  const f = new THREE.Vector3(...cam.fwd);
  controls.target.copy(camera3.position).add(f.multiplyScalar(10));

  const base = current.camera;
  nearInput.value = Math.log10(base.near).toFixed(2);
  farInput.value = Math.log10(base.far).toFixed(2);
  $('bits').value = '24';

  const geo = new THREE.BufferGeometry();
  const verts = [];
  for (const s of current.surfaces) {
    const idx = [0, 1, 2, 0, 2, 3];
    for (const i of idx) verts.push(...s.points[i]);
  }
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ color: 0x5b7cfa, metalness: 0.1, roughness: 0.65, side: THREE.DoubleSide, flatShading: true });
  group.add(new THREE.Mesh(geo, mat));
  const wire = new THREE.LineSegments(new THREE.WireframeGeometry(geo), new THREE.LineBasicMaterial({ color: 0x1b2740 }));
  group.add(wire);

  controls.update();
  update();
}

function update() {
  const near = 10 ** Number(nearInput.value);
  const far = 10 ** Number(farInput.value);
  const bits = Number($('bits').value);
  $('nearv').textContent = near.toFixed(4);
  $('farv').textContent = far.toFixed(1);
  if (!(far > near)) { $('conf').textContent = 'invalid range'; return; }

  const r = analyzeScene(current, { bits, near, far });
  $('conf').textContent = `${r.conflicts} / ${r.overlappingPairs}`;
  $('minu').textContent = r.minUnits === null ? 'n/a' : r.minUnits.toFixed(3) + ' q';
  $('minu2').textContent = r.minUnits === null ? '' : (r.minUnits < 1 ? 'below one quantum → z-fighting' : 'above one quantum');

  // node-baked reference for this scene + bit depth
  const ref = reference.scenes.find((s) => s.scene === current.id);
  const key = bits === 24 ? 'bits24' : 'bits16';
  const isDefault = Math.abs(Math.log10(near / current.camera.near)) < 1e-9 && Math.abs(Math.log10(far / current.camera.far)) < 1e-9;
  $('ref').textContent = isDefault
    ? `default range: conflicts ${ref[key].conflicts}, minUnits ${ref[key].minUnits?.toFixed(3) ?? 'n/a'} (matches node)`
    : `committed default range: conflicts ${ref[key].conflicts} — press T to compare on it`;

  // highlight conflicting surfaces by tinting the whole mesh red
  const mesh = group.children[0];
  if (mesh) mesh.material.color.setHex(r.conflicts > 0 ? 0xff5a5a : 0x5b7cfa);
}

nearInput.addEventListener('input', update);
farInput.addEventListener('input', update);
$('bits').addEventListener('change', update);
sel.addEventListener('change', () => { current = scenes[Number(sel.value)]; build(); });
addEventListener('keydown', (e) => {
  if (e.key !== 't' && e.key !== 'T') return;
  const t = tightRange(current);
  nearInput.value = Math.log10(t.near).toFixed(2);
  farInput.value = Math.log10(t.far).toFixed(2);
  update();
});
addEventListener('resize', () => {
  camera3.aspect = view.clientWidth / view.clientHeight; camera3.updateProjectionMatrix();
  renderer.setSize(view.clientWidth, view.clientHeight);
});

build();
(function loop() { requestAnimationFrame(loop); controls.update(); renderer.render(scene3, camera3); })();
