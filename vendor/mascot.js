// 基于 uibrik AI Mascot 的视觉与动效逻辑，改写为浏览器可直接运行的 ES module。
// 保留：圆润 mochi 身体 + 双眼 + flat 双色阶着色 + 七种状态平滑混合 + 眨眼 + 跟随指针 + 点击 poke。
import * as THREE from "./three.module.js";

const TAU = Math.PI * 2;
const clamp = (x, a, b) => Math.min(Math.max(x, a), b);
const smooth = (x) => { const t = clamp(x, 0, 1); return t * t * (3 - 2 * t); };
const ease = (x) => 1 - (1 - clamp(x, 0, 1)) ** 3;

// ---- 颜色：与页面主绿 #22c55e 协调 ----
function rgbOf(hex) {
  let h = hex.replace("#", "");
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  const n = parseInt(h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
function shift(rgb, k, dl) { return rgb.map((c) => clamp(c * k + dl, 0, 1)); }

// ---- 身体着色器：flat 两色阶 + 左上高光 + 底部暗部（移植自原组件 BODY_FRAG）----
const BODY_VERT = /* glsl */`
  varying vec3 vN; varying vec3 vV;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vN = normalize(normalMatrix * normal);
    vV = -mv.xyz;
    gl_Position = projectionMatrix * mv;
  }
`;
const BODY_FRAG = /* glsl */`
  uniform vec3 uColor; uniform vec3 uShade; uniform vec3 uDeep; uniform vec3 uLight;
  uniform float uSat; uniform float uDim;
  varying vec3 vN; varying vec3 vV;
  void main() {
    vec3 N = normalize(vN); vec3 V = normalize(vV);
    vec3 L = normalize(vec3(-0.5, 0.8, 0.55));
    float lit = smoothstep(-0.13, 0.07, dot(N, L));
    vec3 col = mix(uShade, uColor, lit);
    col = mix(col, uDeep, smoothstep(-0.6, -0.95, N.y) * 0.7);
    vec3 H = normalize(vec3(-0.55, 0.62, 0.56));
    col = mix(col, uLight, smoothstep(0.88, 0.905, dot(N, H)) * 0.55);
    float f = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.0);
    col += uLight * f * 0.12;
    float grey = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(vec3(grey), col, uSat) * uDim;
    gl_FragColor = vec4(col, 1.0);
  }
`;

// ---- Pose：每个状态给一组权重，逐帧平滑混合（移植自原组件 pose()）----
const KEYS = ["y","sx","sy","rx","rz","shake","lookX","lookY","open","happy","sad","eyeScale","sat","dim","follow"];
const rest = () => ({ y:0, sx:1, sy:1, rx:0, rz:0, shake:0, lookX:0, lookY:0, open:1, happy:0, sad:0, eyeScale:1, sat:1, dim:1, follow:1 });
function pose(state, p, t, s, lvl) {
  Object.assign(p, rest());
  switch (state) {
    case "idle": {
      const b = Math.sin(t * 1.6);
      p.y = 0.02 * b; p.sy = 1 + 0.016 * b; p.sx = 1 - 0.008 * b;
      p.lookX = Math.sin(t * 0.37) * 0.22; p.lookY = Math.sin(t * 0.23) * 0.1;
      break;
    }
    case "listening": {
      p.rx = 0.1; p.rz = 0.09; p.eyeScale = 1.14 + lvl * 0.06;
      p.sy = 1 + lvl * 0.03; p.sx = 1 - lvl * 0.012; p.follow = 0.6;
      break;
    }
    case "thinking": {
      const g = Math.sin(t * 1.25);
      const side = Math.tanh(g * 2.5) / Math.tanh(2.5);
      p.lookX = side * 0.55; p.lookY = 0.6; p.rz = -side * 0.06;
      p.y = 0.012 * Math.sin(t * 2.5); p.open = 0.92; p.eyeScale = 0.96; p.follow = 0;
      break;
    }
    case "speaking": {
      p.sy = 1 + 0.06 * lvl; p.sx = 1 - 0.025 * lvl; p.y = 0.025 * lvl;
      p.open = 1 - 0.14 * lvl; p.eyeScale = 1 + 0.04 * lvl;
      p.rz = Math.sin(t * 1.7) * 0.04; p.follow = 0.5;
      break;
    }
    case "success": {
      const h = s < 0.5 ? Math.sin((Math.PI * s) / 0.5) : 0;
      const land = Math.exp(-(((s - 0.55) / 0.08) ** 2));
      const crouch = Math.exp(-((s / 0.06) ** 2));
      p.y = 0.3 * h; p.sy = 1 + 0.06 * h - 0.08 * land - 0.05 * crouch;
      p.sx = 1 - 0.025 * h + 0.05 * land + 0.035 * crouch;
      p.happy = 1; p.follow = 0.3;
      break;
    }
    case "failed": {
      const k = Math.min(s / 0.5, 1);
      const droop = ease((s - 0.3) / 0.45);
      p.shake = Math.sin(s * 36) * 0.06 * (1 - k);
      p.rx = 0.14 * droop; p.y = -0.04 * droop; p.sy = 1 - 0.05 * droop; p.sx = 1 + 0.025 * droop;
      p.sad = 1; p.open = 0.9; p.lookY = -0.45; p.sat = 0.55; p.dim = 0.94; p.follow = 0.1;
      break;
    }
    case "sleeping": {
      const b = Math.sin(t * 0.9);
      p.open = 0.05; p.lookY = -0.2; p.y = -0.03 + 0.016 * b;
      p.sy = 0.965 + 0.022 * b; p.sx = 1.018 - 0.011 * b;
      p.rz = 0.08; p.rx = 0.05; p.dim = 0.93; p.sat = 0.85; p.follow = 0;
      break;
    }
  }
}

// ---- 眼睛：共享一个动态形状几何（移植自原组件 eyeShape）----
const EYE_COLS = 40, CLOSED = 0.017, CRESCENT = 0.026;
function eyeShape() {
  const pos = new Float32Array((EYE_COLS + 1) * 2 * 3);
  const index = [];
  for (let i = 0; i < EYE_COLS; i++) { const a = i * 2; index.push(a, a + 1, a + 2, a + 2, a + 1, a + 3); }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geometry.setIndex(index);
  let key = "";
  const update = (open, happy, w = 0.074, h = 0.112, n = 2.3) => {
    const next = `${open.toFixed(3)}|${happy.toFixed(3)}|${w}|${h}`;
    if (next === key) return; key = next;
    const halfH = CLOSED + (h - CLOSED) * open;
    const thick = halfH + (CRESCENT - halfH) * happy;
    const W = w * (1 + 0.14 * (1 - open) * (1 - happy)) * (1 + 0.3 * happy);
    const A = 0.072 * happy;
    const nn = n + (2 - n) * happy;
    for (let i = 0; i <= EYE_COLS; i++) {
      const u = Math.sin(-Math.PI / 2 + (Math.PI * i) / EYE_COLS);
      const x = u * W;
      const profile = Math.max(1 - Math.abs(u) ** nn, 0) ** (1 / nn);
      const mid = A * (1 - u * u) - A * 0.45;
      const slope = (2 * A * u) / W;
      const k = thick * profile * Math.sqrt(1 + slope * slope);
      pos.set([x, mid + k, 0, x, mid - k, 0], i * 6);
    }
    geometry.attributes.position.needsUpdate = true;
  };
  return { geometry, update };
}

// ---- 身体几何：球体上压出 sit 的 dough 感 ----
function bodyGeometry() {
  const g = new THREE.SphereGeometry(0.94, 48, 32);
  const pos = g.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const yn = v.y / 0.94;
    if (yn < 0) { const u = -yn; v.y = -0.94 * (u - 0.13 * u ** 4); const sp = 1 + 0.05 * u * u * (1 - 0.5 * u); v.x *= sp; v.z *= sp; }
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

const STATES = ["idle","listening","thinking","speaking","success","failed","sleeping"];

/** 在指定容器里创建一只吉祥物，返回可控制状态/销毁的句柄。 */
export function createMascot(host, opts = {}) {
  const size = opts.size || 88;
  const bodyColor = opts.color || "#34d17e";
  const eyeColor = opts.eyeColor || "#0c3527";
  host.style.width = size + "px";
  host.style.height = size + "px";
  host.style.position = "relative";

  let renderer;
  try { renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: "low-power" }); }
  catch { return null; }
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.domElement.style.cssText = "position:absolute;inset:0;width:100%;height:100%;";
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(26, 1, 1, 40);
  camera.position.set(0, 0.35, 6.2);
  camera.lookAt(0, 0.02, 0);

  const base = rgbOf(bodyColor);
  const u = {
    uColor: { value: new THREE.Color(...base) },
    uShade: { value: new THREE.Color(...shift(base, 0.86, -0.02)) },
    uDeep:  { value: new THREE.Color(...shift(base, 0.72, -0.03)) },
    uLight: { value: new THREE.Color(...shift(base, 1, 0.34)) },
    uSat: { value: 1 }, uDim: { value: 1 },
  };
  const bodyMat = new THREE.ShaderMaterial({ vertexShader: BODY_VERT, fragmentShader: BODY_FRAG, uniforms: u });
  const featureMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(...rgbOf(eyeColor)), depthTest: false, depthWrite: false });

  const rig = new THREE.Group(), squash = new THREE.Group(), inner = new THREE.Group();
  const body = new THREE.Mesh(bodyGeometry(), bodyMat);
  inner.add(body); squash.add(inner); rig.add(squash); scene.add(rig);

  const eye = eyeShape();
  const eyeMeshes = [-1, 1].map(() => {
    const g = new THREE.Group();
    const m = new THREE.Mesh(eye.geometry, featureMat);
    m.frustumCulled = false; m.renderOrder = 1; g.add(m); inner.add(g); return g;
  });

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let current = opts.state || "idle";
  const weights = Object.fromEntries(STATES.map((s) => [s, s === current ? 1 : 0]));
  const enteredAt = Object.fromEntries(STATES.map((s) => [s, -10]));
  const scratch = rest(), out = rest();
  const pointer = { x: 0, y: 0, tx: 0, ty: 0 };
  const pop = { x: 0, v: 0 };
  let pokeAt = -10, blinkAt = -10, nextBlink = 2 + Math.random() * 3;
  let time = 0, level = 0, last = 0, lastDraw = 0, raf = 0, visible = true;
  const nVec = new THREE.Vector3(), Z = new THREE.Vector3(0, 0, 1), tilt = new THREE.Quaternion();

  const blend = () => {
    for (const k of KEYS) out[k] = 0;
    let total = 0;
    for (const st of STATES) {
      const w = weights[st]; if (w < 1e-3) continue;
      pose(st, scratch, time, reduced ? 10 : time - enteredAt[st], level);
      for (const k of KEYS) out[k] += scratch[k] * w;
      total += w;
    }
    if (total > 0) for (const k of KEYS) out[k] /= total;
  };

  const render = () => {
    blend();
    const p = out;
    const followRad = reduced ? 0 : ((opts.follow ?? 12) * Math.PI) / 180;
    const fw = p.follow;
    const poked = Math.exp(-(((time - pokeAt - 0.3) / 0.28) ** 2));
    const happy = Math.max(p.happy, poked * (1 - p.sad));

    rig.position.set(p.shake, p.y, 0);
    rig.rotation.set(p.rx - pointer.y * followRad * 0.6 * fw, p.ry || 0 + pointer.x * followRad * fw, -p.rz * (1 - p.sad * 0.4), "YXZ");
    squash.scale.set(p.sx * (1 + pop.x * 0.06), p.sy * (1 - pop.x * 0.1), p.sx * (1 + pop.x * 0.06));

    const lookX = p.lookX + pointer.x * 0.45 * fw;
    const lookY = p.lookY + pointer.y * 0.35 * fw;
    const faceX = lookX * 0.07;
    const faceY = lookY * 0.05;

    const bt = time - blinkAt;
    const shut = bt < 0.07 ? smooth(bt / 0.07) : bt < 0.1 ? 1 : 1 - smooth((bt - 0.1) / 0.14);
    const open = clamp(p.open * (1 - shut) * (1 - p.sad * 0.2), 0, 1);
    const es = p.eyeScale * 0.98;
    eye.update(open, smooth(happy));
    eyeMeshes.forEach((g, i) => {
      const side = i === 0 ? -1 : 1;
      const x = side * 0.23 * 1.0 + faceX + lookX * 0.09;
      const y = 0.1 + faceY + lookY * 0.08 - p.sad * 0.02 - (1 - open) * (1 - happy) * 0.03 * es;
      g.position.set(x, y, 0.9);
      g.quaternion.setFromUnitVectors(Z, nVec.set(-x * 0.28, -y * 0.1, 1).normalize());
      tilt.setFromAxisAngle(Z, side * p.sad * 0.42);
      g.quaternion.multiply(tilt);
      g.scale.setScalar(es);
    });

    u.uSat.value = p.sat; u.uDim.value = p.dim;
    renderer.render(scene, camera);
  };

  const tick = (now) => {
    raf = requestAnimationFrame(tick);
    if (now - lastDraw < 1000 / 60) return;
    lastDraw = now;
    const dt = Math.min((now - (last || now)) / 1000, 1 / 20);
    last = now;
    const sdt = dt * (opts.speed ?? 1);
    time += sdt;
    const k = 1 - Math.exp(-dt * 9);
    for (const st of STATES) weights[st] += ((st === current ? 1 : 0) - weights[st]) * k;

    const synth = current === "speaking"
      ? Math.abs(Math.sin(time * 7.4)) * (0.55 + 0.45 * Math.sin(time * 2.1)) * (0.7 + 0.3 * Math.sin(time * 13.3))
      : 0.5 + 0.5 * Math.sin(time * 4.7) * Math.sin(time * 1.3);
    const target = opts.getLevel ? clamp(opts.getLevel() || 0, 0, 1) : synth;
    level += (target - level) * (1 - Math.exp(-dt * 18));

    pointer.x += (pointer.tx - pointer.x) * (1 - Math.exp(-dt * 6));
    pointer.y += (pointer.ty - pointer.y) * (1 - Math.exp(-dt * 6));
    pop.v += (-pop.x * 260 - pop.v * 16) * dt;
    pop.x += pop.v * dt;

    if (!reduced && time > nextBlink) { blinkAt = time; nextBlink = time + (Math.random() < 0.2 ? 0.28 : 2.4 + Math.random() * 3.6); }
    render();
  };
  const start = () => { if (!raf && visible && !document.hidden && !reduced) { last = 0; raf = requestAnimationFrame(tick); } };
  const stop = () => { cancelAnimationFrame(raf); raf = 0; };
  if (reduced) render();

  const layout = () => {
    const w = host.clientWidth || size, h = host.clientHeight || size;
    if (!w || !h) return;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
    render();
  };
  const ro = new ResizeObserver(layout); ro.observe(host);
  layout();

  const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; if (visible) { render(); start(); } else stop(); });
  io.observe(host);

  const onPointer = (e) => {
    if (!visible) return;
    const r = host.getBoundingClientRect();
    const reach = Math.max(r.width, 200) * 1.2;
    pointer.tx = clamp((e.clientX - (r.left + r.width / 2)) / reach, -1, 1);
    pointer.ty = clamp(-(e.clientY - (r.top + r.height * 0.45)) / reach, -1, 1);
  };
  window.addEventListener("pointermove", onPointer, { passive: true });
  const onVis = () => (document.hidden ? stop() : start());
  document.addEventListener("visibilitychange", onVis);
  start();

  return {
    setState(s) { if (!STATES.includes(s) || s === current) return; current = s; enteredAt[s] = time; if (reduced) { for (const st of STATES) weights[st] = st === s ? 1 : 0; render(); } else pop.v += 3; },
    poke() { pokeAt = time; pop.v += 9; },
    destroy() { stop(); ro.disconnect(); io.disconnect(); window.removeEventListener("pointermove", onPointer); document.removeEventListener("visibilitychange", onVis); renderer.dispose(); body.geometry.dispose(); eye.geometry.dispose(); bodyMat.dispose(); featureMat.dispose(); renderer.domElement.remove(); },
  };
}
