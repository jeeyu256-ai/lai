"use client";

// A small 3D mascot for an AI product, rendered in three.js and shaded flat,
// like an illustration that happens to turn in space: one body colour, a soft
// shadow tone and a crisp highlight. Just a round body and two eyes; every
// feeling comes from how the body squashes and leans and what the eyes do.
// Small enough to take any colour, shape, material or eye style and still
// read as itself.
//
// States blend into one another (each has a weight that eases toward 1 when it
// is active), so switching mid-animation never jumps:
//   idle       breathes, blinks and watches the pointer
//   listening  leans in with a head tilt, eyes wide, soft ripples over its face
//   thinking   glances up from side to side
//   speaking   bounces with each syllable, eyes squinting on the beats
//   success    hops with happy eyes
//   failed     shakes no, then droops with worried eyes and greys out
//   sleeping   eyes closed, slow breaths
//
// Click it for a poke. Pass `getLevel` to drive listening and speaking from a
// real audio level. Sleeps off screen and in background tabs, holds a still
// pose for reduced motion, and shows a flat stand-in until WebGL is ready.

import { useEffect, useRef, useSyncExternalStore, type CSSProperties, type HTMLAttributes } from "react";
import * as THREE from "three";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { cn } from "@/lib/utils";

export type MascotState = "idle" | "listening" | "thinking" | "speaking" | "success" | "failed" | "sleeping";
export type MascotShape = "mochi" | "orb" | "bean" | "block" | "drop";
export type MascotMaterial = "flat" | "soft" | "glow" | "gloss";
export type MascotEyes = "pill" | "round" | "line" | "visor";
export type MascotPreset = "ink" | "peach" | "mint" | "lumen" | "bolt" | "frost";

export type MascotLook = {
  shape: MascotShape;
  material: MascotMaterial;
  /** Body colour. "auto" is charcoal on light pages and near-white on dark ones. */
  color: string;
  /** Eye colour. "auto" picks black or white against the body. */
  eyeColor: string;
  eyes: MascotEyes;
  eyeSize: number;
  eyeGap: number;
};

/** Six ready-made looks. Any look prop you pass on top overrides the preset's value. */
export const MASCOT_PRESETS: Record<MascotPreset, MascotLook> = {
  ink: { shape: "mochi", material: "flat", color: "auto", eyeColor: "auto", eyes: "pill", eyeSize: 1, eyeGap: 1 },
  peach: { shape: "orb", material: "soft", color: "#ffa47e", eyeColor: "#3a1d14", eyes: "round", eyeSize: 1.15, eyeGap: 1 },
  mint: { shape: "bean", material: "flat", color: "#5fd3a8", eyeColor: "#0c3527", eyes: "visor", eyeSize: 1, eyeGap: 1 },
  lumen: { shape: "drop", material: "glow", color: "#7867ff", eyeColor: "#ffffff", eyes: "pill", eyeSize: 0.95, eyeGap: 0.95 },
  bolt: { shape: "block", material: "flat", color: "#ffd03d", eyeColor: "#1b1a17", eyes: "pill", eyeSize: 1.2, eyeGap: 1.1 },
  frost: { shape: "mochi", material: "soft", color: "#c4dcff", eyeColor: "#2450e8", eyes: "line", eyeSize: 1.1, eyeGap: 1 },
};

export type AIMascotProps = Omit<HTMLAttributes<HTMLDivElement>, "children" | "color"> &
  Partial<MascotLook> & {
    /** Starting look. Every look prop you pass overrides it. */
    preset?: MascotPreset;
    /** What the mascot is doing. Changes blend smoothly. */
    state?: MascotState;
    /** Width of the frame in px; it shrinks to fit its container. */
    size?: number;
    /** Most the body turns toward the pointer, in degrees. 0 keeps it facing front. */
    follow?: number;
    /** Speed of every animation. */
    speed?: number;
    /** Click or tap for a poke. */
    interactive?: boolean;
    /** Returns the current audio level, 0 to 1. Read every frame while listening or speaking. */
    getLevel?: () => number;
    /** Read out to screen readers, followed by the state. */
    label?: string;
  };

const STATES: readonly MascotState[] = ["idle", "listening", "thinking", "speaking", "success", "failed", "sleeping"];

// a, b, c: half width, height, depth. e: roundness (2 is an ellipsoid, higher
// is boxier). sit: how much the bottom settles flat and wide, like dough.
// taper: narrows toward the top.
const SHAPES: Record<MascotShape, { a: number; b: number; c: number; e: number; sit: number; taper: number }> = {
  mochi: { a: 0.98, b: 0.9, c: 0.88, e: 2.08, sit: 0.55, taper: 0.05 },
  orb: { a: 0.92, b: 0.9, c: 0.9, e: 2, sit: 0.35, taper: 0 },
  bean: { a: 0.8, b: 1.04, c: 0.76, e: 2.3, sit: 0.6, taper: 0.04 },
  block: { a: 0.92, b: 0.84, c: 0.8, e: 3.4, sit: 0.4, taper: 0 },
  drop: { a: 0.94, b: 1, c: 0.86, e: 2.05, sit: 0.8, taper: 0.4 },
};

// mid/edge: where the shadow tone starts and how soft its edge is.
// shade: shadow lightness as a share of the body's. hi/hiAt/hiSoft: the crisp
// flat highlight. spec: glossy glint. rim: lit edge. glow: lit from within.
const MATERIALS: Record<MascotMaterial, { mid: number; edge: number; shade: number; hi: number; hiAt: number; hiSoft: number; spec: number; rim: number; glow: number }> = {
  flat: { mid: -0.08, edge: 0.05, shade: 0.86, hi: 0.6, hiAt: 0.9, hiSoft: 0.012, spec: 0, rim: 0, glow: 0 },
  soft: { mid: -0.2, edge: 0.55, shade: 0.8, hi: 0.32, hiAt: 0.86, hiSoft: 0.08, spec: 0, rim: 0.08, glow: 0 },
  glow: { mid: -0.3, edge: 0.6, shade: 0.74, hi: 0.25, hiAt: 0.88, hiSoft: 0.06, spec: 0, rim: 0.6, glow: 1 },
  gloss: { mid: -0.15, edge: 0.45, shade: 0.62, hi: 0, hiAt: 0.9, hiSoft: 0.02, spec: 0.55, rim: 0.2, glow: 0 },
};

// ─── Colour ─────────────────────────────────────────────────────────────────
// Tones are built in OKLab so the shadow stays the same colour, only a little
// deeper and cooler, and the highlight a little lighter and warmer.

type RGB = [number, number, number];
const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const gam = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

function rgbOf(hex: string): RGB {
  let h = hex.trim().replace("#", "");
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  const n = parseInt(h.slice(0, 6), 16);
  if (h.length < 6 || Number.isNaN(n)) return [0.5, 0.5, 0.5];
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function oklab([r, g, b]: RGB): RGB {
  const R = lin(r), G = lin(g), B = lin(b);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function fromOklab([L, a, b]: RGB): RGB {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const c = (v: number) => Math.min(Math.max(gam(Math.max(v, 0)), 0), 1);
  return [
    c(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    c(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    c(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

/** Moves a colour's lightness, chroma and hue in OKLCH. */
function shift(rgb: RGB, dl: (l: number) => number, kc: number, dh: number): RGB {
  const [L, a, b] = oklab(rgb);
  const C = Math.hypot(a, b) * kc;
  const H = Math.atan2(b, a) + dh;
  return fromOklab([dl(L), C * Math.cos(H), C * Math.sin(H)]);
}


const lightness = (hex: string) => oklab(rgbOf(hex))[0];

// ─── Shaders ────────────────────────────────────────────────────────────────

const BODY_VERT = /* glsl */ `
uniform float uTime;
uniform float uWobble;
uniform float uRipple;
uniform float uRipplePhase;
varying vec3 vN;
varying vec3 vV;
vec3 disp(vec3 p, vec3 n) {
  float w = sin(p.x * 3.1 + uTime * 2.3) * sin(p.y * 2.7 - uTime * 1.9) * sin(p.z * 2.9 + uTime * 1.7);
  float r = length(p.xy);
  float ring = sin(r * 9.0 - uRipplePhase) * smoothstep(0.0, 0.8, n.z) * exp(-r * 1.4);
  return p + n * (w * uWobble + ring * uRipple);
}
void main() {
  vec3 n = normalize(normal);
  vec3 p = position;
  vec3 nn = n;
  if (uWobble + uRipple > 0.0) {
    vec3 t = normalize(abs(n.y) < 0.99 ? cross(n, vec3(0.0, 1.0, 0.0)) : cross(n, vec3(1.0, 0.0, 0.0)));
    vec3 b = cross(n, t);
    p = disp(position, n);
    vec3 p1 = disp(position + t * 0.01, n);
    vec3 p2 = disp(position + b * 0.01, n);
    nn = normalize(cross(p1 - p, p2 - p));
    if (dot(nn, n) < 0.0) nn = -nn;
  }
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vN = normalize(normalMatrix * nn);
  vV = -mv.xyz;
  gl_Position = projectionMatrix * mv;
}`;

const BODY_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uShade;
uniform vec3 uDeep;
uniform vec3 uLight;
uniform float uMid;
uniform float uEdge;
uniform float uHi;
uniform float uHiAt;
uniform float uHiSoft;
uniform float uSpec;
uniform float uRim;
uniform float uGlow;
uniform float uSat;
uniform float uDim;
varying vec3 vN;
varying vec3 vV;
void main() {
  vec3 N = normalize(vN);
  vec3 V = normalize(vV);
  vec3 L = normalize(vec3(-0.5, 0.8, 0.55));
  // Two tones, the shadow side a soft or sharp step down from the body colour.
  float lit = smoothstep(uMid - uEdge, uMid + uEdge, dot(N, L));
  vec3 col = mix(uShade, uColor, lit);
  // A deeper tone where it sits on the floor.
  col = mix(col, uDeep, smoothstep(-0.6, -0.95, N.y) * 0.7);
  float f = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.0);
  col = mix(col, mix(uColor, uLight, 0.5), (1.0 - f) * uGlow * 0.4);
  col += uLight * f * uRim * (0.4 + 0.6 * lit);
  // The flat highlight: a crisp oval on the upper-left shoulder.
  vec3 H = normalize(vec3(-0.55, 0.62, 0.56));
  col = mix(col, uLight, smoothstep(uHiAt - uHiSoft, uHiAt + uHiSoft, dot(N, H)) * uHi);
  col += vec3(pow(max(dot(N, normalize(L + V)), 0.0), 90.0) * uSpec);
  float grey = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(vec3(grey), col, uSat) * uDim;
  gl_FragColor = vec4(col, 1.0);
}`;

// ─── Poses ──────────────────────────────────────────────────────────────────

const KEYS = [
  "y", "sx", "sy", "rx", "rz", "ry", "shake", "lookX", "lookY", "open", "happy", "sad", "eyeScale",
  "wobble", "ripple", "sat", "dim", "follow", "blink",
] as const;
type Pose = Record<(typeof KEYS)[number], number>;

const restPose = (): Pose => ({
  y: 0, sx: 1, sy: 1, rx: 0, rz: 0, ry: 0, shake: 0, lookX: 0, lookY: 0, open: 1, happy: 0, sad: 0, eyeScale: 1,
  wobble: 0, ripple: 0, sat: 1, dim: 1, follow: 1, blink: 1,
});

const smooth = (x: number) => {
  const t = Math.min(Math.max(x, 0), 1);
  return t * t * (3 - 2 * t);
};
const ease = (x: number) => 1 - (1 - Math.min(Math.max(x, 0), 1)) ** 3;

/** Fills `p` with the pose of one state. t: running time, s: time in this state, lvl: audio 0–1. */
function pose(state: MascotState, p: Pose, t: number, s: number, lvl: number) {
  Object.assign(p, restPose());
  switch (state) {
    case "idle": {
      const b = Math.sin(t * 1.6);
      p.y = 0.02 * b;
      p.sy = 1 + 0.016 * b;
      p.sx = 1 - 0.008 * b;
      p.lookX = Math.sin(t * 0.37) * 0.22;
      p.lookY = Math.sin(t * 0.23) * 0.1;
      break;
    }
    case "listening": {
      p.rx = 0.12;
      p.rz = 0.11;
      p.eyeScale = 1.14 + lvl * 0.06;
      p.sy = 1 + lvl * 0.03;
      p.sx = 1 - lvl * 0.012;
      p.ripple = 0.005 + lvl * 0.018;
      p.follow = 0.6;
      break;
    }
    case "thinking": {
      // Glances up to one side, holds, then the other.
      const g = Math.sin(t * 1.25);
      const side = Math.tanh(g * 2.5) / Math.tanh(2.5);
      p.lookX = side * 0.55;
      p.lookY = 0.6;
      p.ry = side * 0.1;
      p.rz = -side * 0.06;
      p.y = 0.012 * Math.sin(t * 2.5);
      p.open = 0.92;
      p.eyeScale = 0.96;
      p.follow = 0;
      break;
    }
    case "speaking": {
      p.sy = 1 + 0.06 * lvl;
      p.sx = 1 - 0.025 * lvl;
      p.y = 0.025 * lvl;
      p.open = 1 - 0.14 * lvl;
      p.eyeScale = 1 + 0.04 * lvl;
      p.rz = Math.sin(t * 1.7) * 0.04;
      p.follow = 0.5;
      break;
    }
    case "success": {
      const h = s < 0.5 ? Math.sin((Math.PI * s) / 0.5) : 0;
      const land = Math.exp(-(((s - 0.55) / 0.08) ** 2));
      const crouch = Math.exp(-((s / 0.06) ** 2));
      const settle = s > 0.7 ? Math.sin(t * 1.6) : 0;
      p.y = 0.3 * h + 0.015 * settle;
      p.sy = 1 + 0.06 * h - 0.08 * land - 0.05 * crouch + 0.012 * settle;
      p.sx = 1 - 0.025 * h + 0.05 * land + 0.035 * crouch;
      p.happy = 1;
      p.follow = 0.3;
      break;
    }
    case "failed": {
      const k = Math.min(s / 0.5, 1);
      const droop = ease((s - 0.3) / 0.45);
      p.shake = Math.sin(s * 36) * 0.06 * (1 - k);
      p.rx = 0.14 * droop;
      p.y = -0.04 * droop;
      p.sy = 1 - 0.05 * droop;
      p.sx = 1 + 0.025 * droop;
      p.sad = 1;
      p.open = 0.9;
      p.lookY = -0.45;
      p.sat = 0.55;
      p.dim = 0.94;
      p.follow = 0.1;
      break;
    }
    case "sleeping": {
      const b = Math.sin(t * 0.9);
      p.open = 0.05;
      p.lookY = -0.2;
      p.y = -0.03 + 0.016 * b;
      p.sy = 0.965 + 0.022 * b;
      p.sx = 1.018 - 0.011 * b;
      p.rz = 0.08;
      p.rx = 0.05;
      p.dim = 0.93;
      p.sat = 0.85;
      p.follow = 0;
      p.blink = 0;
      break;
    }
  }
}

// ─── Geometry ───────────────────────────────────────────────────────────────

/** The body: a cube-sphere pushed out to a superellipsoid, so there are no pinched poles. */
function bodyGeometry(shape: MascotShape, cheap: boolean) {
  const { a, b, c, e, sit, taper } = SHAPES[shape] ?? SHAPES.mochi;
  const seg = cheap ? 22 : 40;
  let g: THREE.BufferGeometry = new THREE.BoxGeometry(2, 2, 2, seg, seg, seg);
  g.deleteAttribute("normal");
  g.deleteAttribute("uv");
  g = mergeVertices(g);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    const r = (Math.abs(v.x / a) ** e + Math.abs(v.y / b) ** e + Math.abs(v.z / c) ** e) ** (-1 / e);
    v.multiplyScalar(r);
    const yn = v.y / b; // -1 at the bottom, 1 at the top
    // Settle: the lower half slumps a little lower and wider, like soft dough,
    // and the very bottom flattens out. Smooth all the way, so no crease shows.
    if (yn < 0) {
      const u = -yn;
      v.y = -b * (u - 0.16 * sit * u ** 4);
      const spread = 1 + 0.05 * sit * u * u * (1 - 0.5 * u);
      v.x *= spread;
      v.z *= spread;
    } else {
      const k = 1 - taper * yn ** 1.6;
      v.x *= k;
      v.z *= k;
    }
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  g.computeBoundingBox();
  return g;
}

// Half width, half height and edge roundness (2 is an oval, higher is squarer) of each eye style when open.
const EYE_STYLES: Record<MascotEyes, { w: number; h: number; n: number }> = {
  pill: { w: 0.074, h: 0.112, n: 2.3 },
  round: { w: 0.09, h: 0.09, n: 2 },
  line: { w: 0.105, h: 0.04, n: 2.4 },
  visor: { w: 0.3, h: 0.08, n: 3.6 },
};
const EYE_COLS = 40;
const CLOSED = 0.017; // half thickness of a shut eye
const CRESCENT = 0.026; // half thickness of a happy eye at its middle

/**
 * One eye as a flat shape between a top and a bottom edge, rebuilt as it
 * moves: an open oval that closes to a soft line and bends into a happy
 * crescent. It's one shape all the way, so nothing swaps or pops mid-change.
 */
function eyeShape() {
  const pos = new Float32Array((EYE_COLS + 1) * 2 * 3);
  const index: number[] = [];
  for (let i = 0; i < EYE_COLS; i++) {
    const a = i * 2;
    index.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geometry.setIndex(index);
  let key = "";
  /** open: 0 shut to 1 open. happy: 0 to 1 crescent. */
  const update = (style: MascotEyes, open: number, happy: number) => {
    const next = `${style}|${open.toFixed(3)}|${happy.toFixed(3)}`;
    if (next === key) return;
    key = next;
    const st = EYE_STYLES[style] ?? EYE_STYLES.pill;
    const visor = style === "visor";
    const halfH = CLOSED + (st.h - CLOSED) * open;
    const thick = halfH + ((visor ? CRESCENT * 1.4 : CRESCENT) - halfH) * happy;
    const W = st.w * (1 + 0.14 * (1 - open) * (1 - happy)) * (1 + (visor ? 0 : 0.3) * happy);
    const A = (visor ? 0.1 : 0.072) * happy; // how far the crescent arches
    const n = st.n + (2 - st.n) * happy;
    for (let i = 0; i <= EYE_COLS; i++) {
      // Columns bunch up toward the ends, where the outline turns fastest.
      const u = Math.sin(-Math.PI / 2 + (Math.PI * i) / EYE_COLS);
      const x = u * W;
      const profile = Math.max(1 - Math.abs(u) ** n, 0) ** (1 / n);
      const mid = A * (1 - u * u) - A * 0.45;
      // Keep the stroke even where the arch slopes.
      const slope = (2 * A * u) / W;
      const k = thick * profile * Math.sqrt(1 + slope * slope);
      pos.set([x, mid + k, 0, x, mid - k, 0], i * 6);
    }
    geometry.attributes.position.needsUpdate = true;
  };
  return { geometry, update };
}

/** A grid of the body's front surface, so the face sits on it wherever it looks. */
function frontSurface(geometry: THREE.BufferGeometry) {
  const box = geometry.boundingBox!;
  const N = 21;
  const x0 = box.min.x * 0.9, x1 = box.max.x * 0.9, y0 = box.min.y * 0.9, y1 = box.max.y * 0.9;
  const z = new Float32Array(N * N);
  const mat = new THREE.MeshBasicMaterial();
  const mesh = new THREE.Mesh(geometry, mat);
  const ray = new THREE.Raycaster();
  const from = new THREE.Vector3();
  const dir = new THREE.Vector3(0, 0, -1);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      from.set(x0 + ((x1 - x0) * i) / (N - 1), y0 + ((y1 - y0) * j) / (N - 1), 10);
      ray.set(from, dir);
      const hit = ray.intersectObject(mesh, false)[0];
      z[j * N + i] = hit ? hit.point.z : 0;
    }
  }
  mat.dispose();
  const at = (x: number, y: number) => {
    const fx = Math.min(Math.max(((x - x0) / (x1 - x0)) * (N - 1), 0), N - 1.001);
    const fy = Math.min(Math.max(((y - y0) / (y1 - y0)) * (N - 1), 0), N - 1.001);
    const i = Math.floor(fx), j = Math.floor(fy), u = fx - i, w = fy - j;
    const g = (a: number, b: number) => z[b * N + a];
    return (g(i, j) * (1 - u) + g(i + 1, j) * u) * (1 - w) + (g(i, j + 1) * (1 - u) + g(i + 1, j + 1) * u) * w;
  };
  return {
    at,
    normal(x: number, y: number, out: THREE.Vector3) {
      const h = 0.03;
      return out.set(-(at(x + h, y) - at(x - h, y)) / (2 * h), -(at(x, y + h) - at(x, y - h)) / (2 * h), 1).normalize();
    },
  };
}

// ─── Component ──────────────────────────────────────────────────────────────

const subscribeTheme = (onChange: () => void) => {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
};
const pageIsDark = () => document.documentElement.classList.contains("dark");

const lowEnd = () => {
  const nav = navigator as Navigator & { deviceMemory?: number };
  return (nav.hardwareConcurrency ?? 8) <= 4 || (nav.deviceMemory ?? 8) <= 2;
};

type Live = MascotLook & { state: MascotState; follow: number; speed: number; dark: boolean; getLevel?: () => number };
type Api = { look(): void; shape(): void; eyes(): void; state(): void; poke(): void };
const NOOP: Api = { look() {}, shape() {}, eyes() {}, state() {}, poke() {} };

/** Fills in the "auto" colours of a look. */
function resolve(look: MascotLook, dark: boolean): MascotLook {
  const color = !look.color || look.color === "auto" ? (dark ? "#ecebe6" : "#2a2a2f") : look.color;
  const eyeColor = !look.eyeColor || look.eyeColor === "auto" ? (lightness(color) > 0.62 ? "#17171a" : "#f7f7f4") : look.eyeColor;
  return { ...look, color, eyeColor };
}

export function AIMascot({
  preset = "ink",
  state = "idle",
  shape,
  material,
  color,
  eyeColor,
  eyes,
  eyeSize,
  eyeGap,
  size = 280,
  follow = 12,
  speed = 1,
  interactive = true,
  getLevel,
  label = "Assistant",
  className,
  style,
  onPointerDown,
  ...rest
}: AIMascotProps) {
  const base = MASCOT_PRESETS[preset] ?? MASCOT_PRESETS.ink;
  const dark = useSyncExternalStore(subscribeTheme, pageIsDark, () => false);
  const look = resolve(
    {
      shape: shape ?? base.shape,
      material: material ?? base.material,
      color: color ?? base.color,
      eyeColor: eyeColor ?? base.eyeColor,
      eyes: eyes ?? base.eyes,
      eyeSize: eyeSize ?? base.eyeSize,
      eyeGap: eyeGap ?? base.eyeGap,
    },
    dark,
  );

  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const live = useRef<Live>({ ...look, state, follow, speed, dark, getLevel });
  const api = useRef<Api>(NOOP);

  useEffect(() => {
    live.current = { ...look, state, follow, speed, dark, getLevel };
    api.current.look();
  });
  useEffect(() => api.current.shape(), [look.shape]);
  useEffect(() => api.current.eyes(), [look.eyes]);
  useEffect(() => api.current.state(), [state]);

  useEffect(() => {
    const root = rootRef.current!;
    const canvas = canvasRef.current!;
    const cheap = lowEnd();
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: "low-power" });
    } catch {
      return;
    }
    renderer.setClearColor(0x000000, 0);
    // Colours go in as display values and come out untouched.
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(26, 1, 1, 40);
    camera.position.set(0, 0.35, 6.2);
    camera.lookAt(0, 0.02, 0);

    const bodyU = {
      uColor: { value: new THREE.Color() },
      uShade: { value: new THREE.Color() },
      uDeep: { value: new THREE.Color() },
      uLight: { value: new THREE.Color() },
      uMid: { value: 0 },
      uEdge: { value: 0.1 },
      uHi: { value: 0.5 },
      uHiAt: { value: 0.9 },
      uHiSoft: { value: 0.02 },
      uSpec: { value: 0 },
      uRim: { value: 0 },
      uGlow: { value: 0 },
      uSat: { value: 1 },
      uDim: { value: 1 },
      uTime: { value: 0 },
      uWobble: { value: 0 },
      uRipple: { value: 0 },
      uRipplePhase: { value: 0 },
    };
    const bodyMat = new THREE.ShaderMaterial({ vertexShader: BODY_VERT, fragmentShader: BODY_FRAG, uniforms: bodyU });
    // Eyes are drawn over the body, so its ripples never poke through them.
    const featureMat = new THREE.MeshBasicMaterial({ depthTest: false, depthWrite: false });

    // rig (lean, shake) > squash (scaled about the floor) > inner > body + face
    const rig = new THREE.Group();
    const squash = new THREE.Group();
    const inner = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BufferGeometry(), bodyMat);
    inner.add(body);
    squash.add(inner);
    rig.add(squash);
    scene.add(rig);

    // Both eyes share one shape, rebuilt once a frame.
    const eye = eyeShape();
    let eyeList: THREE.Group[] = [];
    // Shapes share one vertex layout, so a change morphs from one to the next.
    type Form = { pos: Float32Array; nrm: Float32Array; at: (x: number, y: number) => number; width: number; top: number; bottom: number };
    let from: Form | null = null;
    let to: Form | null = null;
    let morph = 1;
    let shaped = false; // the working geometry matches `to`
    let surface: { at: (x: number, y: number) => number; normal: (x: number, y: number, out: THREE.Vector3) => THREE.Vector3 } | null = null;
    let width = 1, top = 0.84, bottom = 0.84;

    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    let reduced = mq.matches;
    let visible = false;
    let raf = 0;
    let last = 0;
    let lastDraw = 0;
    let time = 0;
    let ripplePhase = 0;
    let current: MascotState = live.current.state;
    const weights = Object.fromEntries(STATES.map((st) => [st, st === current ? 1 : 0])) as Record<MascotState, number>;
    const enteredAt = Object.fromEntries(STATES.map((st) => [st, -10])) as Record<MascotState, number>;
    const scratch = restPose();
    const out = restPose();
    const pointer = { x: 0, y: 0, tx: 0, ty: 0 };
    const pop = { x: 0, v: 0 };
    let pokeAt = -10;
    let nextBlink = 2 + Math.random() * 3;
    let blinkAt = -10;
    let level = 0;
    const n = new THREE.Vector3();
    const Z = new THREE.Vector3(0, 0, 1);
    const tilt = new THREE.Quaternion();

    const setLook = () => {
      const L = live.current;
      const m = MATERIALS[L.material] ?? MATERIALS.flat;
      const rgb = rgbOf(L.color);
      const deep = lightness(L.color) < 0.35;
      bodyU.uColor.value.setRGB(...rgb);
      // Dark bodies need a bigger step for the shadow to show.
      const k = deep ? m.shade - 0.12 : m.shade;
      bodyU.uShade.value.setRGB(...shift(rgb, (l) => l * k, 1.08, -0.1));
      bodyU.uDeep.value.setRGB(...shift(rgb, (l) => l * (k - 0.1), 1.1, -0.14));
      bodyU.uLight.value.setRGB(...shift(rgb, (l) => l + (1 - l) * (deep ? 0.32 : 0.55), 0.8, 0.06));
      bodyU.uMid.value = m.mid;
      bodyU.uEdge.value = m.edge;
      bodyU.uHi.value = m.hi * (deep ? 0.6 : 1);
      bodyU.uHiAt.value = m.hiAt;
      bodyU.uHiSoft.value = m.hiSoft;
      bodyU.uSpec.value = m.spec;
      bodyU.uRim.value = m.rim;
      bodyU.uGlow.value = m.glow;
      featureMat.color.setRGB(...rgbOf(L.eyeColor));
      render();
    };

    const formOf = (g: THREE.BufferGeometry): Form => {
      const box = g.boundingBox!;
      return {
        pos: (g.attributes.position.array as Float32Array).slice(),
        nrm: (g.attributes.normal.array as Float32Array).slice(),
        at: frontSurface(g).at,
        width: box.max.x,
        top: box.max.y,
        bottom: -box.min.y,
      };
    };

    /** Writes the blend of `from` and `to` at the current morph into the body. */
    const applyShape = () => {
      if (!to || (shaped && morph >= 1)) return;
      const k = from && morph < 1 ? smooth(morph) : 1;
      const a = from ?? to, b = to;
      const pos = body.geometry.attributes.position.array as Float32Array;
      const nrm = body.geometry.attributes.normal.array as Float32Array;
      for (let i = 0; i < pos.length; i += 3) {
        pos[i] = a.pos[i] + (b.pos[i] - a.pos[i]) * k;
        pos[i + 1] = a.pos[i + 1] + (b.pos[i + 1] - a.pos[i + 1]) * k;
        pos[i + 2] = a.pos[i + 2] + (b.pos[i + 2] - a.pos[i + 2]) * k;
        const nx = a.nrm[i] + (b.nrm[i] - a.nrm[i]) * k;
        const ny = a.nrm[i + 1] + (b.nrm[i + 1] - a.nrm[i + 1]) * k;
        const nz = a.nrm[i + 2] + (b.nrm[i + 2] - a.nrm[i + 2]) * k;
        const l = Math.hypot(nx, ny, nz) || 1;
        nrm[i] = nx / l;
        nrm[i + 1] = ny / l;
        nrm[i + 2] = nz / l;
      }
      body.geometry.attributes.position.needsUpdate = true;
      body.geometry.attributes.normal.needsUpdate = true;
      width = a.width + (b.width - a.width) * k;
      top = a.top + (b.top - a.top) * k;
      bottom = a.bottom + (b.bottom - a.bottom) * k;
      const at = k >= 1 ? b.at : (x: number, y: number) => a.at(x, y) + (b.at(x, y) - a.at(x, y)) * k;
      surface = {
        at,
        normal: (x, y, out) => {
          const h = 0.03;
          return out.set(-(at(x + h, y) - at(x - h, y)) / (2 * h), -(at(x, y + h) - at(x, y - h)) / (2 * h), 1).normalize();
        },
      };
      squash.position.y = -bottom;
      inner.position.y = bottom;
      if (k >= 1) from = null;
      shaped = true;
    };

    const buildShape = () => {
      const g = bodyGeometry(live.current.shape, cheap);
      const next = formOf(g);
      if (!to) {
        // First shape: its geometry becomes the working one the morphs write into.
        body.geometry.dispose();
        body.geometry = g;
        body.frustumCulled = false;
        to = next;
        morph = 1;
      } else {
        g.dispose();
        // Start from what is on screen now, even mid-morph.
        const cur = body.geometry.attributes;
        const at = surface!.at;
        from = { pos: (cur.position.array as Float32Array).slice(), nrm: (cur.normal.array as Float32Array).slice(), at, width, top, bottom };
        to = next;
        morph = reduced ? 1 : 0;
        if (!reduced) pop.v += 4;
      }
      shaped = false;
      applyShape();
      root.dataset.gl = "";
      render();
    };

    const buildEyes = () => {
      for (const g of eyeList) inner.remove(g);
      eyeList = Array.from({ length: live.current.eyes === "visor" ? 1 : 2 }, () => {
        const group = new THREE.Group();
        const mesh = new THREE.Mesh(eye.geometry, featureMat);
        mesh.frustumCulled = false;
        mesh.renderOrder = 1;
        group.add(mesh);
        inner.add(group);
        return group;
      });
      render();
    };

    const blend = () => {
      for (const k of KEYS) out[k] = 0;
      let total = 0;
      for (const st of STATES) {
        const w = weights[st];
        if (w < 1e-3) continue;
        pose(st, scratch, time, reduced ? 10 : time - enteredAt[st], level);
        for (const k of KEYS) out[k] += scratch[k] * w;
        total += w;
      }
      if (total > 0) for (const k of KEYS) out[k] /= total;
    };

    const render = () => {
      applyShape();
      if (!visible || !canvas.width || !surface || !eyeList.length) return;
      const L = live.current;
      blend();
      const p = out;
      const followRad = reduced ? 0 : (L.follow * Math.PI) / 180;
      const fw = p.follow;

      // Poke: a squash that springs back, and a flash of happy eyes.
      const poked = Math.exp(-(((time - pokeAt - 0.3) / 0.28) ** 2));
      const happy = Math.max(p.happy, poked * (1 - p.sad));

      rig.position.set(p.shake, p.y, 0);
      rig.rotation.set(p.rx - pointer.y * followRad * 0.6 * fw, p.ry + pointer.x * followRad * fw, -p.rz * (1 - p.sad * 0.4), "YXZ");
      squash.scale.set(p.sx * (1 + pop.x * 0.06), p.sy * (1 - pop.x * 0.1), p.sx * (1 + pop.x * 0.06));

      // The whole face drifts a little the way it looks, the eyes a little more.
      const lookX = p.lookX + pointer.x * 0.45 * fw;
      const lookY = p.lookY + pointer.y * 0.35 * fw;
      const faceX = lookX * 0.07 * width;
      const faceY = lookY * 0.05 * top;

      // A blink shuts fast and opens a little slower, like a real lid.
      const bt = time - blinkAt;
      const shut = bt < 0.07 ? smooth(bt / 0.07) : bt < 0.1 ? 1 : 1 - smooth((bt - 0.1) / 0.14);
      const open = Math.min(Math.max(p.open * (1 - shut * p.blink) * (1 - p.sad * 0.2), 0), 1);
      const closed = (1 - open) * (1 - happy);
      const es = p.eyeScale * L.eyeSize * width;
      eye.update(L.eyes, open, smooth(happy));
      eyeList.forEach((g, i) => {
        const side = eyeList.length === 1 ? 0 : i === 0 ? -1 : 1;
        const x = side * 0.23 * L.eyeGap * width + faceX + lookX * 0.09 * width;
        // A closing eye drops a touch, as if the lid comes down from above.
        const y = 0.1 * top + faceY + lookY * 0.08 * top - p.sad * 0.02 - closed * 0.03 * es;
        g.position.set(x, y, surface!.at(x, y) + 0.004);
        g.quaternion.setFromUnitVectors(Z, surface!.normal(x, y, n));
        tilt.setFromAxisAngle(Z, side * p.sad * 0.42);
        g.quaternion.multiply(tilt);
        g.scale.setScalar(es);
      });

      bodyU.uTime.value = time;
      bodyU.uWobble.value = p.wobble;
      bodyU.uRipple.value = p.ripple;
      bodyU.uRipplePhase.value = ripplePhase;
      bodyU.uSat.value = p.sat;
      bodyU.uDim.value = p.dim;

      renderer.render(scene, camera);
    };

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      // At most 60 frames a second: 120 Hz screens get the same motion for half the work.
      if (now - lastDraw < 1000 / 62) return;
      lastDraw = now;
      const dt = Math.min((now - (last || now)) / 1000, 1 / 20);
      last = now;
      const L = live.current;
      const sdt = dt * Math.max(L.speed, 0);
      time += sdt;
      ripplePhase += sdt * 6;

      const k = 1 - Math.exp(-dt * 9);
      for (const st of STATES) weights[st] += ((st === current ? 1 : 0) - weights[st]) * k;

      // Audio level: the real one when given, otherwise a made-up voice.
      const synth =
        current === "speaking"
          ? Math.abs(Math.sin(time * 7.4)) * (0.55 + 0.45 * Math.sin(time * 2.1)) * (0.7 + 0.3 * Math.sin(time * 13.3))
          : 0.5 + 0.5 * Math.sin(time * 4.7) * Math.sin(time * 1.3);
      const target = L.getLevel ? Math.min(Math.max(L.getLevel() || 0, 0), 1) : synth;
      level += (target - level) * (1 - Math.exp(-dt * 18));

      pointer.x += (pointer.tx - pointer.x) * (1 - Math.exp(-dt * 6));
      pointer.y += (pointer.ty - pointer.y) * (1 - Math.exp(-dt * 6));

      pop.v += (-pop.x * 260 - pop.v * 16) * dt;
      pop.x += pop.v * dt;
      if (morph < 1) {
        morph = Math.min(morph + dt / 0.42, 1);
        shaped = false;
      }

      if (time > nextBlink) {
        blinkAt = time;
        nextBlink = time + (Math.random() < 0.2 ? 0.28 : 2.4 + Math.random() * 3.6);
      }
      render();
    };
    const start = () => {
      if (!raf && visible && !document.hidden && !reduced) {
        last = 0;
        raf = requestAnimationFrame(tick);
      }
    };
    const stop = () => {
      cancelAnimationFrame(raf);
      raf = 0;
    };

    const setState = () => {
      const next = live.current.state;
      if (next === current) return;
      current = next;
      enteredAt[next] = time;
      if (reduced) for (const st of STATES) weights[st] = st === next ? 1 : 0;
      else if (next !== "success") pop.v += 3;
      render();
    };

    const poke = () => {
      if (reduced) return;
      pokeAt = time;
      pop.v += 9;
    };

    const layout = () => {
      const w = root.clientWidth, h = root.clientHeight;
      if (!w || !h) return;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, cheap ? 1.5 : 2));
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      render();
    };

    const onPointer = (e: PointerEvent) => {
      if (!visible) return;
      const r = root.getBoundingClientRect();
      const reach = Math.max(r.width, 200) * 1.2;
      pointer.tx = Math.max(-1, Math.min(1, (e.clientX - (r.left + r.width / 2)) / reach));
      pointer.ty = Math.max(-1, Math.min(1, -(e.clientY - (r.top + r.height * 0.45)) / reach));
    };
    const onLeave = () => {
      pointer.tx = pointer.ty = 0;
    };

    api.current = { look: setLook, shape: buildShape, eyes: buildEyes, state: setState, poke };

    buildShape();
    buildEyes();
    setLook();
    const ro = new ResizeObserver(layout);
    ro.observe(root);
    layout();

    const io = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (visible) {
        render();
        start();
      } else stop();
    });
    io.observe(root);
    const onVisibility = () => (document.hidden ? stop() : start());
    document.addEventListener("visibilitychange", onVisibility);
    const onMotion = () => {
      reduced = mq.matches;
      if (reduced) {
        stop();
        for (const st of STATES) weights[st] = st === current ? 1 : 0;
        pointer.x = pointer.y = pointer.tx = pointer.ty = 0;
        render();
      } else start();
    };
    mq.addEventListener("change", onMotion);
    window.addEventListener("pointermove", onPointer, { passive: true });
    document.documentElement.addEventListener("pointerleave", onLeave);
    const onLost = (e: Event) => {
      e.preventDefault();
      delete root.dataset.gl;
    };
    canvas.addEventListener("webglcontextlost", onLost);

    return () => {
      stop();
      ro.disconnect();
      io.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      mq.removeEventListener("change", onMotion);
      window.removeEventListener("pointermove", onPointer);
      document.documentElement.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("webglcontextlost", onLost);
      body.geometry.dispose();
      eye.geometry.dispose();
      bodyMat.dispose();
      featureMat.dispose();
      renderer.dispose();
      api.current = NOOP;
      delete root.dataset.gl;
    };
  }, []);

  // A flat stand-in while WebGL starts, or where it isn't available.
  const visor = look.eyes === "visor";
  const eyeW = (visor ? 16 : look.eyes === "line" ? 7 : look.eyes === "round" ? 9 : 7.5) * look.eyeSize;
  const eyeH = (visor ? 8 : look.eyes === "line" ? 3 : look.eyes === "round" ? 10.5 : 15) * look.eyeSize;

  return (
    <div
      ref={rootRef}
      role="img"
      aria-label={`${label}, ${state}`}
      {...rest}
      onPointerDown={(e) => {
        onPointerDown?.(e);
        if (interactive) api.current.poke();
      }}
      className={cn("group relative aspect-square shrink-0 select-none", interactive && "cursor-pointer", className)}
      style={{ width: `min(${size}px, 100%)`, ...style } as CSSProperties}
    >
      <div aria-hidden className="absolute inset-0 transition-opacity duration-300 group-data-gl:opacity-0">
        <div
          className="absolute left-1/2 top-[54%] h-[46%] w-[56%] -translate-x-1/2 -translate-y-1/2 rounded-[50%_50%_46%_46%/58%_58%_42%_42%]"
          style={{ background: look.color }}
        >
          {(visor ? [0] : [-1, 1]).map((side) => (
            <span
              key={side}
              className="absolute top-[42%] -translate-x-1/2 -translate-y-1/2 rounded-full"
              style={{ left: `${50 + side * 20 * look.eyeGap}%`, width: `${eyeW}%`, height: `${eyeH}%`, background: look.eyeColor }}
            />
          ))}
        </div>
      </div>
      <canvas ref={canvasRef} className="absolute inset-0 size-full opacity-0 transition-opacity duration-300 group-data-gl:opacity-100" />
    </div>
  );
}

export default AIMascot;
