/**
 * AGENT//FIELD: an 8-bit canvas visualizer and procedural chiptune engine
 * driven by agent activity. More events means more shapes, a faster warp and
 * harder music. Every piece of state lives in the `createAgentField` closure,
 * so two mounts never share anything.
 */

export type FieldOrigin = "claude" | "yarvis";

export interface FieldEvent {
  origin: FieldOrigin;
  type: string;
  source: string;
  label?: string;
}

/** The DOM the engine draws into. The host is sized by the page and observed. */
export interface FieldElements {
  host: HTMLElement;
  canvas: HTMLCanvasElement;
  hud: HTMLElement;
  meter: HTMLElement;
  stats: HTMLElement;
  nodeList: HTMLElement;
  log: HTMLElement;
  manual: HTMLElement;
  slider: HTMLInputElement;
  startOverlay: HTMLElement;
}

export interface AgentField {
  push(ev: FieldEvent): void;
  setLive(connected: boolean): void;
  /** Unlocks audio. Browsers only allow it from a user gesture. */
  start(): void;
  destroy(): void;
}

/* =========================================================
   CONFIG
   ========================================================= */
const PAL = {
  red: "#ff2a3a",
  dred: "#7a0f18",
  white: "#ffffff",
  gray: "#8a8a8a",
  pink: "#ff6b78",
  blush: "#ffb3b8",
};
const WEIGHTS = {
  prompt: 2,
  tool: 1,
  read: 0.6,
  edit: 1.5,
  bash: 1.2,
  search: 1,
  spawn: 3,
  subagent_done: 2,
  done: 2.5,
  error: 4,
  notify: 1,
};
export type FieldEventType = keyof typeof WEIGHTS;
// A set rather than `in WEIGHTS`, so a type like "constructor" can't match an Object method.
const EVENT_TYPES: ReadonlySet<string> = new Set(Object.keys(WEIGHTS));
const HALF_LIFE = 10; // seconds for activity to halve
const SATURATION = 12; // activity needed for ~63% intensity
const CLIMAX_IN = 0.55; // crossing this upward fires the big burst + crash
const CLIMAX_OUT = 0.4; // re-arms once intensity falls below this
const LOGICAL_H = 180; // internal pixel height (upscaled, pixelated)
const MAX_SHAPES = 450;
const MAX_PARTICLES = 1000;
// Effects are pushed by events but expire only in the render pass, which stops
// while the window is hidden. Past a cap the oldest go first.
const MAX_STREAMS = 250;
const MAX_PACKETS = 200;
const MAX_RINGS = 100;
const MAX_ROCKETS = 20;
const MAX_BEATS = 200;
const EVENT_RATE_WINDOW_MS = 60_000; // the HUD's EVT/MIN
// A node with no events for this long spirals away, unless it was only just made.
const NODE_IDLE_EXPIRY_MS = 90_000;
const NODE_MIN_AGE_MS = 5_000;
const TEST_EVENT_TYPES: FieldEventType[] = [
  "read",
  "edit",
  "bash",
  "search",
  "spawn",
  "subagent_done",
  "done",
  "error",
];
const DEMO_AGENTS: { origin: FieldOrigin; source: string }[] = [
  { origin: "claude", source: "orchestrator" },
  { origin: "yarvis", source: "researcher" },
  { origin: "claude", source: "enricher" },
  { origin: "yarvis", source: "router" },
  { origin: "claude", source: "coder" },
  { origin: "yarvis", source: "reviewer" },
];

/** Unknown event types count as a generic tool call. */
export function eventType(type: string): FieldEventType {
  return EVENT_TYPES.has(type) ? (type as FieldEventType) : "tool";
}

/** One node per origin and source: a Claude session and a Yarvis job may share a name. */
export function nodeKey(origin: FieldOrigin, source: string): string {
  return `${origin}:${source}`;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  );
}

const rnd = (a = 1, b?: number) =>
  b === undefined ? Math.random() * a : a + Math.random() * (b - a);
/** Appends and drops the oldest entries past `max`. */
function pushCapped<T>(list: T[], item: T, max: number) {
  list.push(item);
  if (list.length > max) list.splice(0, list.length - max);
}

const pick = <T>(a: readonly T[]): T => a[(Math.random() * a.length) | 0];
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const mtof = (m: number) => 440 * 2 ** ((m - 69) / 12);

/* =========================================================
   SPRITES
   ========================================================= */
const SPR = {
  robot: [
    "..XXXXX..",
    ".X.....X.",
    ".X.R.R.X.",
    ".X.....X.",
    ".X.XXX.X.",
    "..XXXXX..",
    "XXXXXXXXX",
    "X.XXXXX.X",
    "..X...X..",
  ],
  term: [
    "XXXXXXXXXXX",
    "X.........X",
    "X.R.......X",
    "X..R......X",
    "X.R..WWW..X",
    "X.........X",
    "XXXXXXXXXXX",
  ],
  spark: ["...W...", ".W.W.W.", "..WWW..", "WWWRWWW", "..WWW..", ".W.W.W.", "...W..."],
  node: [".XXX.", "XRRRX", "XRWRX", "XRRRX", ".XXX."],
  brace: [
    "..XX.....XX..",
    ".X.........X.",
    ".X...R.R...X.",
    "X...........X",
    ".X...WWW...X.",
    ".X.........X.",
    "..XX.....XX..",
  ],
  brain: [
    "...XXXX.XXXX...",
    ".XXX..X.X..XXX.",
    "X..YY.X.X.YY..X",
    "X.Y...X.X...Y.X",
    "XY..YYX.XYY..YX",
    "X..Y..X.X..Y..X",
    "X.Y..YX.XY..Y.X",
    ".XX.Y.X.X.Y.XX.",
    "..X..YX.XY..X..",
    "...XXX...XXX...",
  ],
} satisfies Record<string, string[]>;
type SpriteName = keyof typeof SPR;
const SPRITE_KINDS: SpriteName[] = ["robot", "term", "spark", "brace", "brain"];
const NODE_SPRITE: Record<FieldOrigin, SpriteName> = { claude: "robot", yarvis: "brain" };

const GEOMS = [
  "square",
  "tri",
  "diamond",
  "hex",
  "circle",
  "cross",
  "bit",
  "bit",
  "chevron",
] as const;
type Geom = (typeof GEOMS)[number];
type Kind = Geom | SpriteName;

/* =========================================================
   TYPES
   ========================================================= */
type Path = "line" | "sine" | "in" | "out" | "orbit";
interface Shape {
  p: Path;
  t: number;
  delay: number;
  rot: number;
  vrot: number;
  size: number;
  kind: Kind;
  color: string;
  head: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  y0: number;
  amp: number;
  f: number;
  ph: number;
  cx: number;
  cy: number;
  r: number;
  r0: number;
  a: number;
  va: number;
  vr: number;
  rmax: number;
  life: number;
}
interface Edge {
  x: number;
  y: number;
  a: number;
}
interface SpawnOpts {
  edge?: Edge;
  kind?: Kind;
  color?: string;
  size?: number;
  gap?: number;
  r0?: number;
  arms?: number;
  a0?: number;
  v?: number;
}
interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  color: string;
  sz: number;
}
interface Rocket {
  x: number;
  y: number;
  vy: number;
  ty: number;
  color: string;
}
interface Ring {
  x: number;
  y: number;
  r: number;
  vr: number;
  life: number;
  color: string;
}
interface Packet {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  p: number;
  sp: number;
  color: string;
}
interface Stream {
  x: number;
  y: number;
  vx: number;
  len: number;
  color: string;
  w: number;
}
interface Star {
  x: number;
  y: number;
  z: number;
}
interface FieldNode {
  source: string;
  origin: FieldOrigin;
  a: number;
  x: number;
  y: number;
  heat: number;
  count: number;
  last: number;
  born: number;
  grow: number;
}
interface MotifNote {
  n: number;
  len: number;
}
type Beat =
  | { t: number; k: "kick" | "snare" | "roll" | "bar" | "drop" }
  | { t: number; k: "lead"; n: number }
  | { t: number; k: "wub"; len: number };
type Pulse = "p125" | "p25" | "p50";
type Wave = OscillatorType | Pulse;
interface ToneOpts {
  slide?: number;
  detune?: number;
  a?: number;
  hold?: boolean;
  /** Route through the pad's lowpass filter instead of straight to the bus. */
  pad?: boolean;
}
interface Audio {
  ctx: AudioContext;
  bus: GainNode;
  master: GainNode;
  dryG: GainNode;
  wetG: GainNode;
  padFilter: BiquadFilterNode;
  noiseBuf: AudioBuffer;
  pulses: Record<Pulse, PeriodicWave>;
}

/* =========================================================
   MUSIC DATA
   ========================================================= */
const SCALE = [0, 2, 3, 5, 7, 8, 11];
const ROOT = 62; // D harmonic minor
const CH = {
  Dm: [50, 53, 57],
  Bb: [46, 50, 53],
  Gm: [43, 46, 50],
  A: [45, 49, 52],
  Eb: [51, 55, 58],
};
const PROG_A = [CH.Dm, CH.Bb, CH.Gm, CH.A];
const PROG_B = [CH.Dm, CH.Bb, CH.Eb, CH.A];

function mulberry(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function crushCurve(steps: number, drive: number) {
  const n = 4096;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.round(Math.tanh(x * drive) * steps) / steps;
  }
  return c;
}
function pulseWave(ctx: AudioContext, d: number) {
  const n = 64;
  const re = new Float32Array(n);
  const im = new Float32Array(n);
  for (let k = 1; k < n; k++) re[k] = (2 / (k * Math.PI)) * Math.sin(k * Math.PI * d);
  return ctx.createPeriodicWave(re, im);
}

export function createAgentField(els: FieldElements): AgentField {
  /* =========================================================
     STATE
     ========================================================= */
  // S is the live state; S.I is intensity (0 to 1), eased each frame toward S.target.
  const S = {
    I: 0,
    target: 0,
    activity: 0,
    manual: false,
    manualVal: 0.4,
    demo: false,
    live: false,
    liveEverOpen: false,
    muted: false,
    started: false,
    climax: false,
    transpose: 0,
    shake: 0,
    flash: 0,
    flashColor: "#fff",
    warp: 0,
    warpDir: 1,
    events: [] as number[],
  };

  /* =========================================================
     AUDIO ENGINE
     chiptune, D harmonic minor. Layers stack with intensity:
     pad (always) > arp > kick > bass > hats > snare > 16th arps > lead > bitcrush > chaos
     ========================================================= */
  let A: Audio | null = null;
  const clock = () => (A ? A.ctx.currentTime : performance.now() / 1000);

  function initAudio() {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) throw new Error("Web Audio is not supported");
    const ctx = new Ctor();
    const master = ctx.createGain();
    master.gain.value = S.muted ? 0 : 0.6;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.ratio.value = 5;
    comp.attack.value = 0.004;
    comp.release.value = 0.12;
    const bus = ctx.createGain();
    const dryG = ctx.createGain();
    const wetG = ctx.createGain();
    wetG.gain.value = 0;
    const crush = ctx.createWaveShaper();
    crush.curve = crushCurve(6, 2.4);
    bus.connect(dryG);
    bus.connect(crush);
    crush.connect(wetG);
    dryG.connect(comp);
    wetG.connect(comp);
    comp.connect(master);
    master.connect(ctx.destination);
    const padFilter = ctx.createBiquadFilter();
    padFilter.type = "lowpass";
    padFilter.frequency.value = 400;
    padFilter.connect(bus);
    const noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const pulses = {
      p125: pulseWave(ctx, 0.125),
      p25: pulseWave(ctx, 0.25),
      p50: pulseWave(ctx, 0.5),
    };
    A = { ctx, bus, master, dryG, wetG, padFilter, noiseBuf, pulses };
    nextT = 0;
    beatQ.length = 0;
  }
  function tone(t: number, midi: number, dur: number, wave: Wave, vol: number, o: ToneOpts = {}) {
    if (!A) return;
    const osc = A.ctx.createOscillator();
    const g = A.ctx.createGain();
    if (wave === "p125" || wave === "p25" || wave === "p50") osc.setPeriodicWave(A.pulses[wave]);
    else osc.type = wave;
    osc.frequency.setValueAtTime(mtof(midi), t);
    if (o.slide) osc.frequency.exponentialRampToValueAtTime(mtof(midi + o.slide), t + dur);
    if (o.detune) osc.detune.setValueAtTime(o.detune, t);
    const a = o.a || 0.004;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + a);
    if (o.hold) {
      g.gain.setValueAtTime(vol, Math.max(t + a, t + dur - 0.03));
      g.gain.linearRampToValueAtTime(0.0001, t + dur);
    } else g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g);
    g.connect(o.pad ? A.padFilter : A.bus);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }
  function noiseHit(t: number, dur: number, vol: number, hp = 1000, lp = 0) {
    if (!A) return;
    const s = A.ctx.createBufferSource();
    s.buffer = A.noiseBuf;
    const f = A.ctx.createBiquadFilter();
    f.type = "highpass";
    f.frequency.value = hp;
    const g = A.ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f);
    if (lp) {
      const l = A.ctx.createBiquadFilter();
      l.type = "lowpass";
      l.frequency.value = lp;
      f.connect(l);
      l.connect(g);
    } else f.connect(g);
    g.connect(A.bus);
    s.start(t, Math.random() * 0.5);
    s.stop(t + dur + 0.02);
  }
  function kick(t: number, v = 1) {
    if (!A) return;
    const o = A.ctx.createOscillator();
    const g = A.ctx.createGain();
    o.type = "sine";
    o.frequency.setValueAtTime(160, t);
    o.frequency.exponentialRampToValueAtTime(38, t + 0.13);
    g.gain.setValueAtTime(0.95 * v, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
    o.connect(g);
    g.connect(A.bus);
    o.start(t);
    o.stop(t + 0.45);
  }
  function snare(t: number, v = 1) {
    noiseHit(t, 0.16, 0.45 * v, 1200);
    tone(t, 52, 0.08, "triangle", 0.25 * v, { slide: -7 });
  }
  function hat(t: number, open: boolean) {
    noiseHit(t, open ? 0.12 : 0.035, open ? 0.12 : 0.09, 7000);
  }

  let motif: (MotifNote | null)[][] = [];
  let seed = 7;
  function genMotif(prog: number[][]) {
    const r = mulberry(seed++);
    motif = [];
    for (let b = 0; b < 4; b++) {
      const ch = prog[b];
      const notes: (MotifNote | null)[] = new Array(16).fill(null);
      for (let s = 0; s < 16; s++) {
        const strong = s % 4 === 0 ? 0.85 : s % 2 === 0 ? 0.45 : 0.22;
        if (r() < strong) {
          const n =
            r() < 0.7 ? ch[(r() * 3) | 0] + 24 : ROOT + SCALE[(r() * 7) | 0] + (r() < 0.5 ? 0 : 12);
          notes[s] = { n, len: r() < 0.35 ? 2 : 1 };
          if (notes[s]?.len === 2) s++;
        }
      }
      motif.push(notes);
    }
  }
  genMotif(PROG_A);

  /* --- scheduler --- */
  let nextT = 0;
  let step = 0;
  let bar = 0;
  let bpm = 96;
  const beatQ: Beat[] = [];
  const pendingSfx: FieldEventType[] = [];
  const stepDur = () => 60 / bpm / 4;
  function sched() {
    const now = clock();
    if (nextT < now) nextT = now + 0.05;
    while (nextT < now + 0.12) {
      playStep(nextT);
      nextT += stepDur();
      step = (step + 1) % 16;
      if (step === 0) {
        bar++;
        onBar();
      }
    }
    // The scheduler keeps running while frames don't (a hidden window), so it trims too.
    if (beatQ.length > MAX_BEATS) beatQ.splice(0, beatQ.length - MAX_BEATS);
  }
  const curProg = () => (S.I > 0.5 && Math.floor(bar / 8) % 2 ? PROG_B : PROG_A);
  function onBar() {
    if (bar % 8 === 0) genMotif(curProg());
    const I = S.I;
    if (!S.climax && I > CLIMAX_IN) {
      S.climax = true;
      crash(nextT);
      beatQ.push({ t: nextT, k: "drop" });
    } else if (S.climax && I < CLIMAX_OUT) S.climax = false;
    if (I > 0.8 && bar % 8 === 0) S.warpDir *= -1;
    if (bar % 4 === 0) S.transpose = I > 0.88 ? 2 : 0; // key lift into overdrive
  }
  function crash(t: number) {
    noiseHit(t, 1.1, 0.35, 400);
    kick(t, 1);
    tone(t, 74, 0.5, "p50", 0.06, { slide: -24 });
  }
  function playStep(t: number) {
    const I = S.I;
    const s = step;
    const pb = bar % 4;
    const tr = S.transpose;
    const ch = curProg()[pb].map((n) => n + tr);
    const sd = stepDur();
    const over = I > 0.88;
    if (A) {
      A.wetG.gain.setTargetAtTime(clamp((I - 0.55) * 1.6, 0, 0.75), t, 0.2);
      A.dryG.gain.setTargetAtTime(1 - clamp((I - 0.55) * 0.8, 0, 0.35), t, 0.2);
      A.padFilter.frequency.setTargetAtTime(300 + I * 1800, t, 0.3);
    }
    // dark pad, always
    if (s === 0) {
      tone(t, ch[0] - 24, sd * 16, "triangle", 0.14, { a: 0.1, pad: true, hold: true });
      tone(t, ch[0] - 12, sd * 16, "sawtooth", 0.05, { a: 0.2, pad: true, hold: true, detune: -8 });
      tone(t, ch[2] - 12, sd * 16, "p50", 0.03, { a: 0.25, pad: true, detune: 7 });
    }
    // arpeggio: 8ths, then 16ths, then octave-jumping chaos
    if (I > 0.08 && (s % 2 === 0 || I > 0.45)) {
      const i = I > 0.45 ? s : s / 2;
      let n = ch[i % 3] + 12 + 12 * (Math.floor(i / 3) % 2);
      if (I > 0.85 && Math.random() < 0.18) n += pick([12, 24, -12, 1, 6]);
      const dive = over && pb === 3 && s >= 12 ? -12 : 0;
      tone(t, n, sd * 0.9, "p125", 0.05 + 0.04 * I, { slide: dive });
      if (I > 0.9) tone(t + sd / 2, ch[(i + 1) % 3] + 24, sd * 0.45, "p125", 0.04, { slide: dive }); // 32nd-note doubles
    }
    // bass: octave pump, driving 16ths when busy
    if (I > 0.28) {
      const drive = I > 0.6;
      if (drive || s % 2 === 0) {
        const bn = ch[0] - 12 + (s % 4 === 2 ? 12 : 0);
        const bd = sd * (drive ? 0.8 : 1.6);
        tone(t, bn, bd, "p25", 0.11);
        if (I > 0.8) tone(t, bn + 7, bd, "p50", 0.05); // power-chord fifth
        if (over && s % 4 === 0) tone(t, bn - 12, sd * 1.8, "triangle", 0.18); // low triangle thump
      }
    }
    // kick
    let k = I > 0.2 && s % 4 === 0;
    if (I > 0.65 && (s === 10 || s === 7)) k = true;
    if (I > 0.85 && s % 2 === 0 && Math.random() < 0.5) k = true;
    if (I > 0.93 && s % 2 === 0) k = true;
    if (over && pb === 3 && s >= 12) k = true; // kick run into each phrase
    if (k) {
      kick(t, 0.7 + 0.3 * I);
      beatQ.push({ t, k: "kick" });
    }
    // snare + fills
    if (I > 0.4 && (s === 4 || s === 12)) {
      snare(t);
      beatQ.push({ t, k: "snare" });
    }
    if (I > 0.78 && pb === 3 && s >= 12) {
      snare(t, 0.5 + (s - 12) * 0.15);
      beatQ.push({ t, k: "roll" });
      if (over) snare(t + sd / 2, 0.45 + (s - 12) * 0.15);
    }
    if (I > 0.93 && s % 4 === 2) {
      snare(t, 0.55);
      beatQ.push({ t, k: "snare" });
    } // blast: snare between every kick
    if (over && s === 0 && pb === 0) noiseHit(t, 0.6, 0.22, 3000); // crash on each phrase
    // hats
    if (I > 0.3 && (s % 4 === 2 || (I > 0.55 && s % 2 === 1) || I > 0.75))
      hat(t, I > 0.6 && s % 8 === 6);
    // lead
    if (I > 0.55) {
      const note = motif[pb]?.[s];
      if (note) {
        const ln = note.n + tr + (I > 0.9 && Math.random() < 0.1 ? 12 : 0);
        const ld = sd * note.len * 0.95;
        tone(t, ln, ld, "p25", 0.06 + 0.03 * I, { detune: I > 0.85 ? rnd(-25, 25) : 0 });
        if (I > 0.82) tone(t, ln + 12, ld, "p125", 0.035); // octave double
        if (over) tone(t + sd * 1.5, ln + 12, ld, "p125", 0.022); // chip echo
        beatQ.push({ t, k: "lead", n: note.n });
      }
    }
    // visual pulse for squads on the bass grid
    if (I > 0.5 && s % 8 === 0) beatQ.push({ t, k: "wub", len: 4 + ((I * 4) | 0) });
    if (s === 0) beatQ.push({ t, k: "bar" });
    for (let n = 0; n < 4 && pendingSfx.length; n++) {
      const type = pendingSfx.shift();
      if (type) sfx(type, t, ch);
    }
    if (pendingSfx.length > 12) pendingSfx.length = 12;
  }
  function sfx(type: FieldEventType, t: number, ch: number[]) {
    const sc = () => ROOT + 12 + SCALE[(Math.random() * 7) | 0] + (Math.random() < 0.4 ? 12 : 0);
    switch (type) {
      case "spawn":
        tone(t, 62, 0.28, "p50", 0.06, { slide: 24 });
        break;
      case "subagent_done":
        tone(t, ch[0] + 36, 0.12, "p125", 0.06);
        tone(t + 0.06, ch[2] + 36, 0.16, "p125", 0.05);
        break;
      case "done":
        ch.concat(ch[0] + 12).forEach((n, i) => {
          tone(t + i * 0.045, n + 24, 0.2, "p25", 0.055);
        });
        break;
      case "error":
        tone(t, 50, 0.45, "sawtooth", 0.09, { slide: -24 });
        noiseHit(t, 0.25, 0.25, 300);
        break;
      case "prompt":
        tone(t, 86, 0.22, "p50", 0.05, { slide: -12 });
        noiseHit(t, 0.08, 0.12, 3000);
        break;
      case "notify":
        tone(t, 93, 0.18, "triangle", 0.07);
        break;
      default:
        tone(t, sc(), 0.05, "p125", 0.04);
    }
  }
  // Runs before audio is unlocked too: the beat queue drives the visuals either way.
  const schedTimer = setInterval(sched, 25);

  /* =========================================================
     SIMULATION
     ========================================================= */
  let W = 320;
  let H = LOGICAL_H;
  let shapes: Shape[] = [];
  let particles: Particle[] = [];
  let rockets: Rocket[] = [];
  let rings: Ring[] = [];
  let packets: Packet[] = [];
  let streams: Stream[] = [];
  let stars: Star[] = [];
  const nodes = new Map<string, FieldNode>();
  let coreSpin = 0;
  let corePulse = 0;
  let glitchFrames = 0;
  const core = () => ({ x: W * 0.5, y: H * 0.5 });

  function mk(o: Partial<Shape> & { p: Path }) {
    if (shapes.length > MAX_SHAPES) return;
    shapes.push({
      t: 0,
      delay: 0,
      rot: rnd(6.28),
      vrot: rnd(-4, 4),
      size: rnd(2, 6) | 0,
      kind: pick(GEOMS),
      color: pick([PAL.white, PAL.red, PAL.pink]),
      head: 0,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      y0: 0,
      amp: 0,
      f: 0,
      ph: 0,
      cx: 0,
      cy: 0,
      r: 0,
      r0: 0,
      a: 0,
      va: 0,
      vr: 0,
      rmax: 0,
      life: 0,
      ...o,
    });
  }
  const spd = () => 1 + 1.6 * S.I;
  const aspect = () => [(W / H) * 0.62, 1]; // stretch spirals to the screen shape

  // pattern spawners ------------------------------------------------
  function fromEdge(): Edge {
    // random edge point and a heading across the screen
    const side = (Math.random() * 4) | 0;
    let x: number;
    let y: number;
    if (side === 0) {
      x = -10;
      y = rnd(H);
    } else if (side === 1) {
      x = W + 10;
      y = rnd(H);
    } else if (side === 2) {
      x = rnd(W);
      y = -10;
    } else {
      x = rnd(W);
      y = H + 10;
    }
    const tx = rnd(W * 0.2, W * 0.8);
    const ty = rnd(H * 0.2, H * 0.8);
    return { x, y, a: Math.atan2(ty - y, tx - x) };
  }
  function squad(n = 1, o: SpawnOpts = {}) {
    // straight line, n shapes in single file
    const e = o.edge || fromEdge();
    const v = rnd(50, 110) * spd();
    const kind = o.kind || pick(GEOMS);
    const color = o.color || pick([PAL.white, PAL.red, PAL.pink, PAL.gray]);
    const size = o.size || rnd(2, 5) | 0;
    for (let i = 0; i < n; i++)
      mk({
        p: "line",
        x: e.x,
        y: e.y,
        vx: Math.cos(e.a) * v,
        vy: Math.sin(e.a) * v,
        head: e.a,
        delay: i * (o.gap || 0.09),
        kind,
        color,
        size,
      });
  }
  function wall(n = 5) {
    // n shapes abreast, moving together
    const fromLeft = Math.random() < 0.5;
    const v = (fromLeft ? 1 : -1) * rnd(60, 120) * spd();
    const kind = pick(GEOMS);
    const color = pick([PAL.white, PAL.red]);
    const y0 = rnd(H * 0.1, H * 0.5);
    const gap = rnd(8, 16);
    for (let i = 0; i < n; i++)
      mk({
        p: "line",
        x: fromLeft ? -10 : W + 10,
        y: y0 + i * gap,
        vx: v,
        vy: 0,
        head: fromLeft ? 0 : Math.PI,
        kind,
        color,
        size: 3,
        delay: Math.abs(i - (n - 1) / 2) * 0.06,
      });
  }
  function wave(n = 8) {
    // sine train
    const fromLeft = Math.random() < 0.5;
    const v = (fromLeft ? 1 : -1) * rnd(50, 90) * spd();
    const kind = pick(GEOMS);
    const color = pick([PAL.pink, PAL.white, PAL.red]);
    const y0 = rnd(H * 0.2, H * 0.8);
    const amp = rnd(10, 35);
    const f = rnd(2, 4);
    for (let i = 0; i < n; i++)
      mk({
        p: "sine",
        x: fromLeft ? -10 : W + 10,
        y0,
        vx: v,
        amp,
        f,
        ph: 0,
        delay: i * 0.08,
        kind,
        color,
        size: 2 + (i % 2),
      });
  }
  function spiralIn(cx: number, cy: number, n = 8, o: SpawnOpts = {}) {
    // converge onto a point, spinning faster as they close in
    const r0 = o.r0 || Math.hypot(W, H) * 0.55;
    const kind = o.kind || pick(GEOMS);
    const color = o.color || pick([PAL.white, PAL.red, PAL.pink]);
    const arms = o.arms || 1;
    const dir = Math.random() < 0.5 ? 1 : -1;
    for (let i = 0; i < n; i++) {
      const arm = i % arms;
      mk({
        p: "in",
        cx,
        cy,
        r: r0,
        r0,
        a: (arm / arms) * 6.28 + (o.a0 || 0),
        va: dir * rnd(1.2, 1.8),
        vr: rnd(55, 85) * spd(),
        delay: Math.floor(i / arms) * (o.gap || 0.1),
        kind,
        color,
        size: o.size || 3,
      });
    }
  }
  function spiralOut(cx: number, cy: number, n = 8, o: SpawnOpts = {}) {
    // unwind outward from a point
    const kind = o.kind || pick(GEOMS);
    const color = o.color || pick([PAL.white, PAL.red, PAL.pink]);
    const arms = o.arms || 1;
    const dir = Math.random() < 0.5 ? 1 : -1;
    for (let i = 0; i < n; i++) {
      const arm = i % arms;
      mk({
        p: "out",
        cx,
        cy,
        r: 1,
        a: (arm / arms) * 6.28 + (o.a0 || 0),
        va: dir * rnd(1.4, 2.2),
        vr: rnd(35, 60) * spd(),
        rmax: Math.hypot(W, H) * 0.6,
        delay: Math.floor(i / arms) * (o.gap || 0.08),
        kind,
        color,
        size: o.size || 3,
      });
    }
  }
  function radial(cx: number, cy: number, n = 10, o: SpawnOpts = {}) {
    // straight rays out of a point
    const kind = o.kind || pick(GEOMS);
    const color = o.color || PAL.white;
    const v = (o.v || 90) * spd();
    const a0 = rnd(6.28);
    for (let i = 0; i < n; i++) {
      const a = a0 + (i / n) * 6.28;
      mk({
        p: "line",
        x: cx,
        y: cy,
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v,
        head: a,
        kind,
        color,
        size: o.size || 2,
      });
    }
  }
  function orbit(cx: number, cy: number, n = 6) {
    // circle a point, then fling off tangentially
    const kind = pick(GEOMS);
    const color = pick([PAL.white, PAL.pink]);
    const r = rnd(18, 40);
    const dir = Math.random() < 0.5 ? 1 : -1;
    const life = rnd(1.5, 3);
    for (let i = 0; i < n; i++)
      mk({
        p: "orbit",
        cx,
        cy,
        r,
        a: (i / n) * 6.28,
        va: dir * rnd(2, 3) * spd(),
        life,
        kind,
        color,
        size: 2,
      });
  }
  function flyer(kind: SpriteName) {
    const e = fromEdge();
    const v = rnd(45, 90) * spd();
    mk({
      p: "line",
      x: e.x,
      y: e.y,
      vx: Math.cos(e.a) * v,
      vy: Math.sin(e.a) * v,
      kind,
      color: PAL.white,
      size: Math.random() < 0.35 ? 6 : 3,
      vrot: 0,
    });
  }

  function ambientSpawn() {
    const I = S.I;
    const r = Math.random();
    const c = core();
    if (I < 0.25) {
      if (r < 0.6) squad(1);
      else if (r < 0.85) wave(4);
      else flyer(pick(SPRITE_KINDS));
      return;
    }
    if (r < 0.22) squad(1 + ((Math.random() * 5 * I) | 0));
    else if (r < 0.36) wall(3 + ((I * 5) | 0));
    else if (r < 0.5) wave(5 + ((I * 6) | 0));
    else if (r < 0.64)
      spiralIn(
        Math.random() < 0.5 ? c.x : rnd(W * 0.2, W * 0.8),
        Math.random() < 0.5 ? c.y : rnd(H * 0.2, H * 0.8),
        6 + ((I * 10) | 0),
        { arms: 1 + ((Math.random() * 3 * I) | 0) },
      );
    else if (r < 0.78)
      spiralOut(c.x, c.y, 6 + ((I * 10) | 0), { arms: 1 + ((Math.random() * 4 * I) | 0) });
    else if (r < 0.88) orbit(rnd(W * 0.2, W * 0.8), rnd(H * 0.2, H * 0.8), 4 + ((I * 6) | 0));
    else flyer(pick(SPRITE_KINDS));
  }
  function updShape(m: Shape, dt: number) {
    if (m.delay > 0) {
      m.delay -= dt;
      return true;
    }
    m.t += dt;
    m.rot += m.vrot * dt;
    const [sx, sy] = aspect();
    switch (m.p) {
      case "line":
        m.x += m.vx * dt;
        m.y += m.vy * dt;
        break;
      case "sine":
        m.x += m.vx * dt;
        m.y = m.y0 + Math.sin(m.t * m.f + m.ph) * m.amp;
        m.head = m.vx > 0 ? 0 : Math.PI;
        break;
      case "in": {
        const k = m.r / m.r0;
        m.r -= m.vr * dt * (0.35 + k);
        m.a += m.va * dt * (1 + (1 - k) * 3);
        if (m.r <= 1.5) {
          burst(m.cx, m.cy, 3, [m.color]);
          return false;
        }
        m.x = m.cx + Math.cos(m.a) * m.r * sx;
        m.y = m.cy + Math.sin(m.a) * m.r * sy;
        m.head = m.a + (Math.PI / 2) * Math.sign(m.va);
        break;
      }
      case "out":
        m.r += m.vr * dt * (1 + m.r / 120);
        m.a += m.va * dt;
        if (m.r > m.rmax) return false;
        m.x = m.cx + Math.cos(m.a) * m.r * sx;
        m.y = m.cy + Math.sin(m.a) * m.r * sy;
        m.head = m.a;
        break;
      case "orbit":
        m.a += m.va * dt;
        m.x = m.cx + Math.cos(m.a) * m.r * sx;
        m.y = m.cy + Math.sin(m.a) * m.r * sy;
        if (m.t > m.life) {
          const tang = m.a + (Math.PI / 2) * Math.sign(m.va);
          const v = Math.abs(m.va) * m.r * 1.2;
          m.p = "line";
          m.vx = Math.cos(tang) * v;
          m.vy = Math.sin(tang) * v;
          m.head = tang;
        }
        break;
    }
    return m.x > -60 && m.x < W + 60 && m.y > -60 && m.y < H + 60;
  }

  /* --- secondary fx --- */
  function spawnStream(color: string, y?: number, w = 1) {
    const dir = Math.random() < 0.85 ? -1 : 1;
    pushCapped(
      streams,
      {
        x: dir < 0 ? W + rnd(0, 20) : -rnd(0, 20),
        y: y ?? rnd(6, H - 6),
        vx: dir * rnd(120, 240) * (1 + S.I),
        len: rnd(10, 30) * (1 + S.I * 0.6),
        color,
        w,
      },
      MAX_STREAMS,
    );
  }
  function burst(x: number, y: number, n: number, colors: string[]) {
    for (let i = 0; i < n; i++) {
      const a = rnd(6.28);
      const sp = rnd(10, 60);
      particles.push({
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        life: 0,
        max: rnd(0.4, 1.1),
        color: pick(colors),
        sz: Math.random() < 0.12 ? 2 : 1,
      });
    }
    if (particles.length > MAX_PARTICLES) particles.splice(0, particles.length - MAX_PARTICLES);
  }
  function firework() {
    pushCapped(
      rockets,
      {
        x: rnd(W * 0.15, W * 0.85),
        y: H + 2,
        vy: -rnd(110, 150),
        ty: rnd(20, H * 0.45),
        color: pick([PAL.white, PAL.red, PAL.pink]),
      },
      MAX_ROCKETS,
    );
  }
  function ring(x: number, y: number, color: string, vr = 90) {
    pushCapped(rings, { x, y, r: 1, vr, life: 1, color }, MAX_RINGS);
  }
  function packet(x0: number, y0: number, x1: number, y1: number, color: string) {
    pushCapped(
      packets,
      { x0, y0, x1, y1, p: 0, sp: rnd(1.2, 2.2) * (1 + S.I), color },
      MAX_PACKETS,
    );
  }
  function initStars() {
    stars = [];
    for (let i = 0; i < 160; i++) stars.push({ x: rnd(-1, 1), y: rnd(-1, 1), z: rnd(0.05, 1) });
  }

  /* --- agent nodes (one per origin and event source) --- */
  function ensureNode(origin: FieldOrigin, src: string) {
    const key = nodeKey(origin, src);
    let n = nodes.get(key);
    if (!n) {
      const c = core();
      n = {
        source: src,
        origin,
        a: rnd(6.28),
        x: c.x,
        y: c.y,
        heat: 0,
        count: 0,
        last: 0,
        born: performance.now(),
        grow: 0,
      };
      nodes.set(key, n);
      ring(n.x, n.y, PAL.white, 60);
    }
    return n;
  }
  let orbitPhase = 0;
  let breathPhase = 0;
  function layoutNodes(dt: number) {
    const arr = [...nodes.values()];
    const c = core();
    const R = Math.min(W * 0.32, H * 0.3);
    const I = S.I;
    orbitPhase += dt * (0.12 + 4.2 * I ** 1.6); // rad/s: lazy drift -> fast whirl
    breathPhase += dt * Math.PI * (bpm / 60) * (I > 0.6 ? 1 : 0.5); // one in/out per 2 beats, per beat when busy
    const amp = 0.06 + 0.42 * I ** 1.3; // in/out depth grows with chaos
    arr.forEach((n, i) => {
      const ta = (i / arr.length) * Math.PI * 2 + orbitPhase;
      n.a += (((ta - n.a + Math.PI * 3) % (Math.PI * 2)) - Math.PI) * Math.min(1, dt * 6);
      n.grow = Math.min(1, n.grow + dt * 1.5);
      // alternate nodes breathe in opposite phase -> star/pulse pattern; kicks punch outward
      const breath =
        1 + amp * Math.sin(breathPhase + (i % 2 ? Math.PI : 0) + i * 0.4) + corePulse * 0.18 * I;
      const r = R * n.grow * Math.max(0.25, breath);
      n.x = c.x + Math.cos(n.a) * r * 1.35;
      n.y = c.y + Math.sin(n.a) * r * 0.85;
      n.heat *= Math.exp(-dt * 1.2);
    });
    const now = performance.now();
    for (const [k, n] of nodes)
      if (now - n.last > NODE_IDLE_EXPIRY_MS && now - n.born > NODE_MIN_AGE_MS) {
        spiralOut(n.x, n.y, 6, { color: PAL.gray });
        nodes.delete(k);
      }
  }

  /* =========================================================
     EVENTS
     ========================================================= */
  const logLines: { cls: string; text: string }[] = [];
  function onEvent(ev: FieldEvent) {
    const type = eventType(ev.type);
    const src = ev.source || "agent";
    S.activity += WEIGHTS[type];
    const now = performance.now();
    S.events.push(now);
    while (S.events.length && now - S.events[0] >= EVENT_RATE_WINDOW_MS) S.events.shift();
    pendingSfx.push(type);
    const n = ensureNode(ev.origin, src);
    n.heat = Math.min(1, n.heat + 0.25);
    n.count++;
    n.last = now;
    const c = core();
    switch (type) {
      case "read":
        squad(1, { kind: "bit", color: PAL.gray });
        packet(c.x, c.y, n.x, n.y, PAL.gray);
        break;
      case "edit":
        squad(3, { kind: "diamond", color: PAL.red });
        spawnStream(PAL.red, undefined, 2);
        packet(n.x, n.y, c.x, c.y, PAL.red);
        break;
      case "bash":
        squad(2, { kind: "cross", color: PAL.white, gap: 0.05 });
        spawnStream(PAL.white);
        packet(n.x, n.y, c.x, c.y, PAL.white);
        break;
      case "search":
        wave(6);
        break;
      case "tool":
        squad(1, { kind: pick(["tri", "chevron", "hex"] as const), color: PAL.blush });
        packet(n.x, n.y, c.x, c.y, PAL.blush);
        break;
      case "spawn":
        spiralIn(n.x, n.y, 8, { r0: Math.hypot(W, H) * 0.4, kind: "square", color: PAL.white });
        flyer(NODE_SPRITE[ev.origin]);
        ring(n.x, n.y, PAL.red, 80);
        break;
      case "subagent_done":
        spiralOut(n.x, n.y, 10, { arms: 2, kind: "diamond", color: PAL.white });
        burst(n.x, n.y, 16, [PAL.white, PAL.red]);
        break;
      case "done":
        spiralOut(c.x, c.y, 18, { arms: 3, kind: pick(["square", "hex", "tri"] as const) });
        firework();
        if (S.I > 0.6) firework();
        ring(c.x, c.y, PAL.white, 140);
        break;
      case "error":
        S.flash = 0.5;
        S.flashColor = PAL.red;
        S.shake = Math.max(S.shake, 6);
        glitchFrames = 8;
        radial(n.x, n.y, 10, { kind: "tri", color: PAL.red, v: 110 });
        break;
      case "prompt":
        flyer("term");
        spiralIn(c.x, c.y, 12, { arms: 3, kind: "chevron", color: PAL.white });
        ring(c.x, c.y, PAL.white, 120);
        for (const m of nodes.values()) packet(c.x, c.y, m.x, m.y, PAL.white);
        break;
      case "notify":
        flyer("spark");
        orbit(c.x, c.y, 5);
        break;
    }
    const cls =
      type === "error"
        ? "text-[#ff3344]"
        : type === "done" || type === "spawn" || type === "prompt"
          ? "text-white"
          : "text-[#8a8a8a]";
    logLines.unshift({
      cls,
      text: `${type.padEnd(13, " ")} ${ev.origin}/${src}${ev.label ? `  ${ev.label}` : ""}`,
    });
    if (logLines.length > 7) logLines.length = 7;
  }

  /* --- demo generator --- */
  let demoT = 0;
  function demoTick(dt: number) {
    demoT += dt;
    const w = 0.5 + 0.5 * Math.sin(demoT / 22);
    const rate = 0.25 + 7 * w * w * w;
    let k = rate * dt;
    while (k > 0) {
      if (Math.random() < Math.min(1, k)) {
        const r = Math.random();
        const type: FieldEventType =
          r < 0.28
            ? "read"
            : r < 0.46
              ? "edit"
              : r < 0.6
                ? "bash"
                : r < 0.7
                  ? "search"
                  : r < 0.8
                    ? "tool"
                    : r < 0.86
                      ? "spawn"
                      : r < 0.91
                        ? "subagent_done"
                        : r < 0.94
                          ? "done"
                          : r < 0.97
                            ? "error"
                            : r < 0.985
                              ? "prompt"
                              : "notify";
        const agent = pick(DEMO_AGENTS.slice(0, 2 + Math.floor(w * 4)));
        onEvent({ type, origin: agent.origin, source: agent.source, label: "" });
      }
      k -= 1;
    }
  }

  /* =========================================================
     GRAPHICS
     ========================================================= */
  // The glitch pass reads pixels back every frame; the canvas is small enough for the CPU path.
  const ctx = els.canvas.getContext("2d", { willReadFrequently: true });
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  function resize(w: number, h: number) {
    if (w <= 0 || h <= 0) return;
    W = Math.round((LOGICAL_H * w) / h);
    H = LOGICAL_H;
    els.canvas.width = W;
    els.canvas.height = H;
    if (ctx) ctx.imageSmoothingEnabled = false;
  }
  const resizeObserver = new ResizeObserver((entries) => {
    const box = entries[entries.length - 1]?.contentRect;
    if (box) resize(box.width, box.height);
  });
  resizeObserver.observe(els.host);

  // Drawing needs a 2D context; without one (e.g. a test DOM) the HUD still runs.
  const draw = ctx ? createRenderer(ctx) : null;

  function createRenderer(g: CanvasRenderingContext2D) {
    function drawSpr(
      spr: string[],
      x0: number,
      y0: number,
      map: { X: string; [k: string]: string },
      sc = 1,
    ) {
      const w = spr[0].length * sc;
      const h = spr.length * sc;
      const x = Math.round(x0 - w / 2);
      const y = Math.round(y0 - h / 2);
      for (let r = 0; r < spr.length; r++) {
        const row = spr[r];
        for (let c = 0; c < row.length; c++) {
          const ch = row[c];
          if (ch === ".") continue;
          g.fillStyle = map[ch] || map.X;
          g.fillRect(x + c * sc, y + r * sc, sc, sc);
        }
      }
    }
    const px = (x: number, y: number) => g.fillRect(x | 0, y | 0, 1, 1);
    function line(x0: number, y0: number, x1: number, y1: number) {
      const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) | 0;
      for (let i = 0; i <= n; i++) {
        const f = n ? i / n : 0;
        px(x0 + (x1 - x0) * f, y0 + (y1 - y0) * f);
      }
    }
    function poly(x: number, y: number, r: number, k: number, rot: number) {
      let lx = 0;
      let ly = 0;
      for (let i = 0; i <= k; i++) {
        const a = rot + (i / k) * Math.PI * 2;
        const X = x + Math.cos(a) * r;
        const Y = y + Math.sin(a) * r;
        if (i) line(lx, ly, X, Y);
        lx = X;
        ly = Y;
      }
    }
    function drawShape(m: Shape) {
      g.fillStyle = m.color;
      const s = m.size;
      const x = m.x;
      const y = m.y;
      const r = m.rot;
      switch (m.kind) {
        case "square":
          poly(x, y, s, 4, r);
          break;
        case "tri":
          poly(x, y, s, 3, r);
          break;
        case "diamond":
          poly(x, y, s, 4, Math.PI / 4 + r * 0.2);
          px(x, y);
          break;
        case "hex":
          poly(x, y, s, 6, r);
          break;
        case "circle":
          for (let a = 0; a < 6.28; a += 1 / s) px(x + Math.cos(a) * s, y + Math.sin(a) * s);
          break;
        case "cross":
          line(x - s, y, x + s, y);
          line(x, y - s, x, y + s);
          break;
        case "bit":
          g.fillRect(
            (x - s / 3) | 0,
            (y - s / 3) | 0,
            Math.max(1, s * 0.66) | 0,
            Math.max(1, s * 0.66) | 0,
          );
          break;
        case "chevron": {
          const c = Math.cos(m.head);
          const sn = Math.sin(m.head);
          line(x + c * s, y + sn * s, x - c * s - sn * s, y - sn * s + c * s);
          line(x + c * s, y + sn * s, x - c * s + sn * s, y - sn * s - c * s);
          break;
        }
        default:
          drawSpr(
            SPR[m.kind],
            x,
            y,
            { X: m.color, R: PAL.red, W: PAL.white, Y: PAL.red },
            m.size > 4 ? 2 : 1,
          );
      }
    }

    return (now: number, dt: number) => {
      const I = S.I;
      const c = core();

      // beat sync
      const t = clock();
      while (beatQ.length && beatQ[0].t <= t) {
        const b = beatQ.shift();
        if (!b) break;
        if (b.k === "kick") {
          corePulse = 1;
          S.warp = Math.max(S.warp, 0.6 + I * 1.5);
          S.shake = Math.max(S.shake, 0.4 + I * 2.2);
          S.flash = Math.max(S.flash, 0.03 + 0.1 * I);
          S.flashColor = PAL.white;
        } else if (b.k === "snare") {
          ring(c.x, c.y, PAL.red, 100 + I * 80);
          if (I > 0.5)
            radial(c.x, c.y, 6 + ((I * 8) | 0), {
              kind: pick(GEOMS),
              color: pick([PAL.white, PAL.red]),
            });
        } else if (b.k === "roll") {
          ring(c.x, c.y, PAL.red, 60);
        } else if (b.k === "wub") {
          if (I > 0.5 && Math.random() < 0.7) squad(Math.min(8, b.len), { gap: 0.06 });
        } else if (b.k === "lead") {
          if (I > 0.72) spawnStream(PAL.red, H * 0.85 - ((b.n - 60) % 24) * 5);
        } else if (b.k === "bar") {
          if (I > 0.35) ambientSpawn();
        } else if (b.k === "drop") {
          S.flash = 0.45;
          S.flashColor = PAL.white;
          S.shake = 6;
          S.warp = 4;
          spiralOut(c.x, c.y, 24, { arms: 6, kind: "square", color: PAL.white });
          spiralOut(c.x, c.y, 12, { arms: 4, kind: "tri", color: PAL.red });
          ring(c.x, c.y, PAL.white, 200);
        }
      }
      // ambient shapes
      spawnAcc += dt * (0.5 + 5 * I ** 1.4);
      while (spawnAcc > 1) {
        spawnAcc -= 1;
        ambientSpawn();
      }
      if (Math.random() < dt * (0.8 + I * 7)) spawnStream(pick([PAL.red, PAL.white, PAL.gray]));

      // ---- draw ----
      g.save();
      const sh = S.shake;
      if (sh > 0.1) g.translate(Math.round(rnd(-sh, sh)), Math.round(rnd(-sh, sh)));
      S.shake *= Math.exp(-dt * 9);
      g.fillStyle = `rgba(4,0,2,${0.55 - 0.17 * I})`;
      g.fillRect(-10, -10, W + 20, H + 20);

      // starfield warp (outward, flips inward every 8 bars at high intensity)
      S.warp *= Math.exp(-dt * 3);
      const zs = (0.06 + 0.7 * I + S.warp * 0.3) * dt * S.warpDir;
      for (const s of stars) {
        const ox = c.x + (s.x / s.z) * W * 0.5;
        const oy = c.y + (s.y / s.z) * H * 0.5;
        s.z -= zs;
        if (s.z < 0.03 || s.z > 1.05) {
          s.x = rnd(-1, 1);
          s.y = rnd(-1, 1);
          s.z = S.warpDir > 0 ? rnd(0.8, 1) : rnd(0.05, 0.2);
          continue;
        }
        const nx = c.x + (s.x / s.z) * W * 0.5;
        const ny = c.y + (s.y / s.z) * H * 0.5;
        if (nx < 0 || nx > W || ny < 0 || ny > H) {
          s.z = S.warpDir > 0 ? rnd(0.8, 1) : rnd(0.05, 0.2);
          s.x = rnd(-1, 1);
          s.y = rnd(-1, 1);
          continue;
        }
        const b = 1 - s.z;
        g.fillStyle = b > 0.8 ? PAL.white : b > 0.5 ? "#6a6a6a" : "#2e1014";
        if (Math.abs(zs) > 0.012) line(ox, oy, nx, ny);
        else px(nx, ny);
      }

      // core + node graph
      layoutNodes(dt);
      coreSpin += dt * (0.4 + I * 4);
      corePulse *= Math.exp(-dt * 6);
      for (const n of nodes.values()) {
        const steps = Math.max(4, (Math.hypot(n.x - c.x, n.y - c.y) / 4) | 0);
        const ph = Math.floor(now / 120);
        g.fillStyle = n.heat > 0.5 ? PAL.red : "#3a0c12";
        for (let i = 0; i < steps; i++)
          if ((i + ph) % 2 === 0) {
            const f = i / steps;
            px(c.x + (n.x - c.x) * f, c.y + (n.y - c.y) * f);
          }
      }
      const cr = 6 + corePulse * 4 + I * 3;
      g.fillStyle = PAL.white;
      for (let i = 0; i < 8; i++) {
        const a = coreSpin + (i * Math.PI) / 4;
        const r2 = cr + 3 + corePulse * 3;
        px(c.x + Math.cos(a) * r2, c.y + Math.sin(a) * r2);
      }
      g.fillStyle = PAL.red;
      for (let a = 0; a < 6.28; a += Math.PI / (10 + cr))
        px(c.x + Math.cos(a) * cr, c.y + Math.sin(a) * cr);
      drawSpr(SPR.node, c.x, c.y, { X: PAL.red, R: PAL.dred, W: PAL.white });
      for (const n of nodes.values()) {
        drawSpr(SPR[NODE_SPRITE[n.origin]], n.x, n.y, {
          X: n.heat > 0.4 ? PAL.white : PAL.gray,
          R: PAL.red,
          Y: PAL.red,
        });
        g.fillStyle = PAL.red;
        g.fillRect((n.x - 4) | 0, (n.y + 6) | 0, Math.round(9 * n.heat), 1);
      }
      packets = packets.filter((p) => {
        p.p += p.sp * dt;
        const f = Math.min(1, p.p);
        for (let k = 0; k < 4; k++) {
          const ff = Math.max(0, f - k * 0.03);
          g.globalAlpha = 1 - k * 0.25;
          g.fillStyle = p.color;
          px(p.x0 + (p.x1 - p.x0) * ff, p.y0 + (p.y1 - p.y0) * ff);
        }
        g.globalAlpha = 1;
        if (p.p >= 1) {
          burst(p.x1, p.y1, 3, [p.color]);
          return false;
        }
        return true;
      });

      // streams
      streams = streams.filter((s) => {
        s.x += s.vx * dt;
        const dir = Math.sign(s.vx);
        for (let i = 0; i < s.len; i += 2) {
          g.globalAlpha = 1 - i / s.len;
          g.fillStyle = i < 2 ? PAL.white : s.color;
          g.fillRect((s.x - dir * i) | 0, s.y | 0, 2, s.w);
        }
        g.globalAlpha = 1;
        return s.x > -80 && s.x < W + 80;
      });

      // shapes
      shapes = shapes.filter((m) => {
        const alive = updShape(m, dt);
        if (alive && m.delay <= 0) drawShape(m);
        return alive;
      });

      // rockets + particles (only from completions now)
      rockets = rockets.filter((r) => {
        r.y += r.vy * dt;
        g.fillStyle = r.color;
        g.fillRect(r.x | 0, r.y | 0, 1, 2);
        if (r.y <= r.ty) {
          burst(r.x, r.y, 28 + I * 24, [r.color, PAL.white]);
          ring(r.x, r.y, r.color, 50);
          return false;
        }
        return true;
      });
      particles = particles.filter((p) => {
        p.life += dt;
        p.vy += 25 * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        const k = 1 - p.life / p.max;
        if (k <= 0) return false;
        g.globalAlpha = k < 0.3 ? (Math.random() < 0.5 ? k * 2 : 0) : 1;
        g.fillStyle = p.color;
        g.fillRect(p.x | 0, p.y | 0, p.sz, p.sz);
        return true;
      });
      g.globalAlpha = 1;
      rings = rings.filter((r) => {
        r.r += r.vr * dt;
        r.life -= dt * 1.3;
        if (r.life <= 0) return false;
        g.globalAlpha = r.life;
        g.fillStyle = r.color;
        const st = Math.PI / Math.max(8, r.r * 1.2);
        for (let a = 0; a < 6.28; a += st) px(r.x + Math.cos(a) * r.r, r.y + Math.sin(a) * r.r);
        g.globalAlpha = 1;
        return true;
      });

      // Photosensitivity: a full-screen flash on every kick (kicks start above 0.2
      // intensity, alpha 0.03 + 0.1 * I), on every error (0.5, red, at any intensity)
      // and on the climax drop (0.45, when intensity crosses 0.55). Off for reduced motion.
      if (S.flash > 0.01 && !reducedMotion) {
        g.globalAlpha = S.flash;
        g.fillStyle = S.flashColor;
        g.fillRect(-10, -10, W + 20, H + 20);
        g.globalAlpha = 1;
      }
      S.flash *= Math.exp(-dt * 10);
      g.restore();

      // glitch post-process: random above 0.65 intensity, and 8 frames on every error.
      // Above 0.92, each glitch frame has a 3% chance to invert the whole frame.
      // Reduced motion keeps only the red scanline.
      if (I > 0.65 && Math.random() < (I - 0.65) * 1.1) glitchFrames = Math.max(glitchFrames, 2);
      if (glitchFrames > 0) {
        glitchFrames--;
        const slices = 2 + ((I * 6) | 0);
        for (let i = 0; i < slices && !reducedMotion; i++) {
          const y = rnd(H) | 0;
          const h = rnd(2, 14) | 0;
          const dx = rnd(-20, 20) | 0;
          try {
            g.putImageData(g.getImageData(0, y, W, h), dx, y);
          } catch {
            // A slice that can't be read is skipped; the glitch is decoration.
          }
        }
        g.globalAlpha = 0.5;
        g.fillStyle = PAL.red;
        g.fillRect(0, rnd(H) | 0, W, 1);
        g.globalAlpha = 1;
        if (I > 0.92 && Math.random() < 0.03 && !reducedMotion) {
          g.globalCompositeOperation = "difference";
          g.fillStyle = "#fff";
          g.fillRect(0, 0, W, H);
          g.globalCompositeOperation = "source-over";
        }
      }
    };
  }

  /* =========================================================
     HUD
     ========================================================= */
  const meterCells: HTMLElement[] = [];
  for (let i = 0; i < 20; i++) {
    const cell = document.createElement("i");
    els.meter.appendChild(cell);
    meterCells.push(cell);
  }
  const METER_OFF = "h-3 w-[9px] bg-[#2a0a0e]";
  const METER_ON = "h-3 w-[9px] bg-[#ff2a3a] shadow-[0_0_6px_#ff2a3a]";
  const METER_HOT = "h-3 w-[9px] bg-white shadow-[0_0_8px_#fff]";

  // Node ids and log labels come from hook payloads (file names, commands), so
  // they only ever reach the DOM as text.
  function drawHud() {
    const lit = Math.round(S.I * 20);
    meterCells.forEach((el, i) => {
      el.className = i < lit ? (i >= 16 ? METER_HOT : METER_ON) : METER_OFF;
    });
    const now = performance.now();
    S.events = S.events.filter((t) => now - t < EVENT_RATE_WINDOW_MS);
    const feed = S.live ? (S.demo ? "LIVE+DEMO" : "LIVE") : S.demo ? "DEMO" : "WAITING";
    const mode = S.manual ? "MANUAL" : feed;
    const sect = S.I < 0.2 ? "IDLE" : S.I < 0.55 ? "BUILD" : S.I < 0.85 ? "RUSH" : "OVERDRIVE";
    els.stats.textContent = `${mode}  ${sect}  ${Math.round(bpm)} BPM  ${String(Math.round(S.I * 100)).padStart(3, " ")}%\n${S.events.length} EVT/MIN  ${nodes.size} AGENTS${S.muted ? "  [MUTED]" : ""}`;

    const arr = [...nodes.values()].sort((a, b) => b.last - a.last).slice(0, 8);
    els.nodeList.replaceChildren(
      ...arr.map((n) => {
        const row = document.createElement("div");
        row.className = n.heat > 0.4 ? "agent-field-glow text-white" : "text-[#8a8a8a]";
        const origin = document.createElement("span");
        origin.className = "opacity-60";
        origin.textContent = `${n.origin}/`;
        const bar = document.createElement("span");
        bar.className =
          "ml-1.5 inline-block h-1.5 bg-[#ff2a3a] align-middle shadow-[0_0_4px_#ff2a3a]";
        bar.style.width = `${Math.round(4 + n.heat * 40)}px`;
        row.append(origin, n.source, bar);
        return row;
      }),
    );
    els.log.replaceChildren(
      ...logLines.map((l) => {
        const row = document.createElement("div");
        row.className = `truncate ${l.cls}`;
        row.textContent = `> ${l.text}`;
        return row;
      }),
    );
  }

  /* =========================================================
     FRAME LOOP
     ========================================================= */
  let last = performance.now();
  let hudT = 0;
  let spawnAcc = 0;
  let raf = 0;
  function frame(now: number) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (S.demo) demoTick(dt);
    S.activity *= Math.exp((-dt * Math.LN2) / HALF_LIFE);
    S.target = S.manual ? S.manualVal : 1 - Math.exp(-S.activity / SATURATION);
    S.I += (S.target - S.I) * Math.min(1, dt * 1.2);
    const bt = 100 + 95 * S.I;
    bpm += (bt - bpm) * Math.min(1, dt * 0.8);

    if (draw) draw(now, dt);

    hudT += dt;
    if (hudT > 0.1) {
      hudT = 0;
      drawHud();
    }
    raf = requestAnimationFrame(frame);
  }

  /* =========================================================
     INPUT
     ========================================================= */
  function start() {
    if (S.started) return;
    S.started = true;
    els.startOverlay.hidden = true;
    try {
      initAudio();
    } catch (e) {
      console.warn("audio unavailable", e);
    }
  }
  function onKeyDown(e: KeyboardEvent) {
    // Cmd/Ctrl+digit switches app tabs, and typing elsewhere must not drive the field.
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.repeat) return;
    // Overlays above the field (Omni Chat's approval bar, dialogs) have keys of their own.
    const target = e.target;
    if (target !== document.body && !(target instanceof Node && els.host.contains(target))) return;
    if (target !== els.slider && isTypingTarget(target)) return;
    if (!S.started) {
      // Escape is how a dialog closes, not a request for sound.
      if (e.key === "Escape") return;
      start();
      return;
    }
    const k = e.key.toLowerCase();
    if (k === "s") {
      S.muted = !S.muted;
      if (A) A.master.gain.setTargetAtTime(S.muted ? 0 : 0.6, A.ctx.currentTime, 0.05);
    } else if (k === "d") {
      S.demo = !S.demo;
    } else if (k === "a") {
      S.manual = !S.manual;
      els.manual.hidden = !S.manual;
    } else if (k === "h") {
      els.hud.hidden = !els.hud.hidden;
    } else if (k === "f") {
      if (document.fullscreenElement) void document.exitFullscreen();
      else els.host.requestFullscreen().catch(() => {});
    } else if (k >= "1" && k <= "8") {
      onEvent({
        type: TEST_EVENT_TYPES[Number(k) - 1],
        origin: "claude",
        source: "manual",
        label: "test",
      });
    }
  }
  function onSlider() {
    S.manualVal = Number(els.slider.value) / 100;
  }
  window.addEventListener("keydown", onKeyDown);
  els.slider.addEventListener("input", onSlider);

  resize(els.host.clientWidth, els.host.clientHeight);
  initStars();
  raf = requestAnimationFrame(frame);

  return {
    push: onEvent,
    setLive(connected) {
      // Called on every stream frame: a ping must not undo the user's D.
      if (connected && S.live) return;
      S.live = connected;
      if (connected) {
        // The automatic fallback demo gives way to the real feed.
        S.liveEverOpen = true;
        S.demo = false;
      } else if (!S.liveEverOpen) S.demo = true;
    },
    start,
    destroy() {
      cancelAnimationFrame(raf);
      clearInterval(schedTimer);
      resizeObserver.disconnect();
      window.removeEventListener("keydown", onKeyDown);
      els.slider.removeEventListener("input", onSlider);
      if (A) void A.ctx.close();
      A = null;
      // Hand the DOM back as it was given, so a remount (React StrictMode) starts clean.
      els.meter.replaceChildren();
      els.nodeList.replaceChildren();
      els.log.replaceChildren();
      els.stats.textContent = "";
      els.hud.hidden = false;
      els.manual.hidden = true;
      els.startOverlay.hidden = false;
    },
  };
}
