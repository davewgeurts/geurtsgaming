/**
 * The very first thing the arcade demo shows: the hangar of Space Pilot School, on a space station,
 * seen from across the floor.
 *
 * On a pilot's very first visit, they pick once right here in the hangar:
 *   1. Low-poly pilot avatar (boys, girls and animals, each with coloured wireframe facets and emotions)
 *   2. Neon colour theme (tinting ship hull, thrusters and cockpit/HUD trim while keeping bolts crisp sand)
 *   3. One of the three ships parked across Bays 1–3 (Swift fast interceptor, Starhawk balanced fighter,
 *      or Bastion heavy armoured gunship)
 *
 * Clicking a ship saves the loadout to localStorage and sends the pilot walking across the hangar floor
 * to that bay's ladder, climbing into the cockpit, shutting the canopy and rolling out through the space door.
 * On returning visits the saved loadout loads automatically and the pilot walks straight to their ship
 * (with a Hangar toolbar button and `H` key whenever they fancy a change).
 */
import { renderAvatarFrame, type Mood } from './avatar';
import { BLUE, MINT, NEON, PINK, SAND, box3d, clamp, lerp, smooth, type Ink } from './core';
import { fitTo, traceText } from './font';
import { WORDS } from './lines';
import {
  PILOTS,
  PILOT_BY_ID,
  PILOT_IDS,
  SHIPS,
  SHIP_BY_ID,
  SHIP_IDS,
  THEMES,
  THEME_BY_ID,
  type HangarHat,
  type PilotEmote,
  type PilotId,
  type PilotLoadout,
  type PilotSpec,
  type ShipId,
  type ThemeId,
} from './loadout';
import { makeProblem } from './maths';
import { DROGUE, SHIP, TANKER, shipShape, trace, traceShipThrusters } from './shapes';

export type HangarInk = Ink;
export type HangarCue = 'bell' | 'step' | 'canopy' | 'key' | 'power';
export type HangarStage = 'avatar' | 'theme' | 'ship' | 'boarding';

export interface HangarBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface HangarFrame {
  ctx: CanvasRenderingContext2D;
  ink: HangarInk;
  w: number;
  h: number;
  inset?: { top: number; right: number; bottom: number; left: number };
  time: number;
  touch: boolean;
  reduceMotion?: boolean;
}

// The boarding scene, in seconds: the pilot sets off, reaches the ladder, climbs it, sits down,
// shuts the canopy, and rolls out through the hangar door.
const WALK_FROM = 0.7;
const WALK_TO = 5.3;
const CLIMBED = 6.5;
const SEATED = 7.1;
const SHUT = 7.7;
const END = 8.9;
/** Seconds a fade to or from black takes. */
const FADE = 0.4;
/** Short input grace on opening each picker step so a launch press or prior tap never double-picks. */
export const HANGAR_STAGE_GRACE = 0.25;

// The hangar, in metres. x runs left to right, y up, z away from the camera.
const HALF = 24;
const DEPTH = 48;
const WALL = 11;
const ROOF = 19;
const DOOR_HALF = 11;
const DOOR_TOP = 11;
const ARCHES = [6, 18, 30, 42, DEPTH];
/** Where the pilot stands waiting while choosing a ship, and sets off from once one is chosen. */
const START = { x: -0.6, z: 4.4 };
/** How high the pilot's feet are once they are sitting in the cockpit. */
const SEAT_Y = 0.5;
/** Nothing nearer the camera than this is drawn. */
const NEAR = 0.6;
/** How fast the pilot's stride cycles, in radians a second. */
const STRIDES = 7.4;

const { cyan: CYAN, lime: LIME, yellow: YELLOW, orange: ORANGE, violet: VIOLET } = NEON;

const PREVIEW_MOODS: readonly Mood[] = ['happy', 'talk', 'calm', 'laugh', 'worried', 'happy'];

export type DanceMove = 'wave' | 'boogie' | 'starhop' | 'hype';
export type HangarActivity = 'jacks' | 'dance' | 'sleep' | 'eat' | 'practice' | 'mathExtra';
export type CatchZone = 'leftApron' | 'rightApron' | 'midRunway';

export interface HangarScenario {
  readonly seed: number;
  /** Shuffled order of all 8 pilots; filtering out `loadout.pilot` yields the 7 squadmates in the hangar. */
  readonly rosterOrder: readonly PilotId[];
  readonly catchZone: CatchZone;
  readonly mathSecondSleeps: boolean;
  readonly antics: readonly [HangarActivity, HangarActivity, HangarActivity];
  readonly dances: readonly DanceMove[];
  readonly phases: readonly number[];
}

const DANCE_MOVES: readonly DanceMove[] = ['wave', 'boogie', 'starhop', 'hype'];

function scenarioRng(seed: number): () => number {
  let s = seed >>> 0 || 0x9e3779b9;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildScenario(rawSeed?: number): HangarScenario {
  const seed = (rawSeed ?? Math.floor(Math.random() * 0xffffffff)) >>> 0 || 0x9e3779b9;
  const rng = scenarioRng(seed);

  const roster = [...PILOT_IDS];
  for (let i = roster.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [roster[i], roster[j]] = [roster[j]!, roster[i]!];
  }

  const zones: readonly CatchZone[] = ['leftApron', 'rightApron', 'midRunway'];
  const catchZone = zones[Math.floor(rng() * zones.length)]!;
  const mathSecondSleeps = rng() < 0.35;

  // Weighted pool of hangar antics drawn without replacement so every visit feels distinct and lively:
  const pool: Array<{ kind: HangarActivity; weight: number }> = [
    { kind: 'jacks', weight: 3.2 },
    { kind: 'dance', weight: 3.0 },
    { kind: 'sleep', weight: 2.2 },
    { kind: 'eat', weight: 2.2 },
    { kind: 'practice', weight: 2.2 },
    { kind: 'mathExtra', weight: 1.6 },
  ];
  const picked: HangarActivity[] = [];
  while (picked.length < 3) {
    const total = pool.reduce((sum, item) => sum + item.weight, 0);
    let r = rng() * total;
    let idx = 0;
    for (let i = 0; i < pool.length; i++) {
      r -= pool[i]!.weight;
      if (r <= 0) {
        idx = i;
        break;
      }
    }
    picked.push(pool[idx]!.kind);
    pool.splice(idx, 1);
  }

  const dances = Array.from({ length: 8 }, () => DANCE_MOVES[Math.floor(rng() * DANCE_MOVES.length)]!);
  const phases = Array.from({ length: 8 }, () => rng() * 20);

  return {
    seed,
    rosterOrder: roster,
    catchZone,
    mathSecondSleeps,
    antics: [picked[0]!, picked[1]!, picked[2]!],
    dances,
    phases,
  };
}

interface LimbAim {
  /** Upper-arm direction [x, y, z] in local pilot space (+x right, +y up, +z forward). */
  upper: [number, number, number];
  /** Forearm direction [x, y, z] in local pilot space. */
  fore: [number, number, number];
}

/** How a person is standing. Angles are in radians; phases run through a step (or a rung) every 2π. */
interface Pose {
  x: number; y: number; z: number;
  /** Which way they face: 0 is away from the camera, a quarter turn is to the right. */
  face: number;
  scale: number;
  /** Walking: where in the stride they are. null stands still. */
  stride: number | null;
  seated: boolean;
  /** Stretched out horizontally on a bench/cot for a hangar nap. */
  lying?: boolean;
  sleeping?: boolean;
  happy?: boolean;
  /** Optional named pilot avatar for full 3D head/snout/ears/visor/tail geometry. */
  pilotId?: PilotId;
  tailPhase?: number;
  hipShiftX?: number;
  squat?: number;
  legSpread?: number;
  legKickL?: number;
  legKickR?: number;
  armL?: LimbAim;
  armR?: LimbAim;
  /** How far the right arm is raised forwards, 0 (by their side) to 1 (straight up). */
  reach: number;
  /** Both arms up, as if on a ladder. */
  climbing: boolean;
  hat: 'helmet' | 'cap' | 'none' | HangarHat;
  pack: boolean;
  /** A pointer or tool held in the right hand, in metres long. */
  tool: number;
}

const person = (over: Partial<Pose> & { x: number; z: number }): Pose => ({
  y: 0, face: 0, scale: 1, stride: null, seated: false, reach: 0, climbing: false, hat: 'helmet', pack: false, tool: 0, ...over,
});

function hitBox(x: number, y: number, b: HangarBox, slack = 4): boolean {
  return x >= b.x - slack && x <= b.x + b.w + slack && y >= b.y - slack && y <= b.y + b.h + slack;
}

function cutRectPath(ctx: CanvasRenderingContext2D, b: HangarBox, cut = 8): void {
  const c = Math.min(cut, b.w * 0.22, b.h * 0.22);
  ctx.moveTo(b.x + c, b.y);
  ctx.lineTo(b.x + b.w - c, b.y);
  ctx.lineTo(b.x + b.w, b.y + c);
  ctx.lineTo(b.x + b.w, b.y + b.h - c);
  ctx.lineTo(b.x + b.w - c, b.y + b.h);
  ctx.lineTo(b.x + c, b.y + b.h);
  ctx.lineTo(b.x, b.y + b.h - c);
  ctx.lineTo(b.x, b.y + c);
  ctx.closePath();
}

export interface HangarOptions {
  initialLoadout: PilotLoadout;
  hasSavedLoadout: boolean;
  reduceMotion: boolean;
  scenarioSeed?: number;
  onCommitLoadout?: (loadout: PilotLoadout) => void;
  onAnnounce?: (message: string) => void;
  onPilotVoice?: (pilot: PilotId, text: string) => void;
}

export interface HangarCadetTarget extends HangarBox {
  id: PilotId;
  slot: number;
  worldX: number;
  worldZ: number;
}

export interface HangarUiSnapshot {
  navBtn: HangarBox | null;
  partyBtn: HangarBox | null;
  quickFlyBtn: HangarBox | null;
  avatarCards: readonly HangarBox[];
  themeCards: readonly HangarBox[];
  shipPlaques: readonly HangarBox[];
  shipTargets: readonly HangarBox[];
  cadetTargets: readonly HangarCadetTarget[];
}

export interface ActivePilotTagline {
  readonly pilot: PilotId;
  readonly text: string;
  readonly emote: PilotEmote;
  age: number;
}

export class Hangar {
  /** Seconds into the current stage (`boarding` timeline runs 0..END). */
  t = 0;
  done = false;
  stage: HangarStage;
  loadout: PilotLoadout;
  scenario: HangarScenario;

  private focusPilot = 0;
  private focusTheme = 0;
  private focusShip = 1;
  private focusSince = 0;
  private stageAge = 0;
  private clock = 0;
  private reduceMotion: boolean;
  private readonly onCommit?: (loadout: PilotLoadout) => void;
  private readonly onAnnounce?: (message: string) => void;
  private readonly onPilotVoice?: (pilot: PilotId, text: string) => void;

  /** Cycling tagline state for Step 1 Avatar hover/focus previews. */
  activeTagline: ActivePilotTagline | null = null;
  private readonly taglineCursor: Record<PilotId, number> = {
    nova: 0,
    leo: 0,
    maya: 0,
    kai: 0,
    fox: 0,
    cat: 0,
    wolf: 0,
    owl: 0,
  };
  private pendingVoice: { pilot: PilotId; text: string; wait: number } | null = null;

  /** Interactive hangar easter eggs: full-squad Dance Party + clickable cadet reactions! */
  dancePartyTimer = 0;
  cadetReaction: {
    id: PilotId;
    slot: number;
    callout: string;
    timer: number;
    worldX: number;
    worldZ: number;
  } | null = null;

  private w = 1280;
  private h = 800;
  private lastInset = { top: 0, right: 0, bottom: 0, left: 0 };
  private steps = 0;
  private rang = false;
  private shut = false;

  // Camera state for 3D -> 2D projection.
  private cx = 0;
  private cy = 0;
  private cz = 0;
  private cosYaw = 1;
  private sinYaw = 0;
  private cosPitch = 1;
  private sinPitch = 0;
  private focal = 1;
  private eye = 0;
  private ctx: CanvasRenderingContext2D | null = null;
  private sx = 0;
  private sy = 0;
  private sd = 0;

  /** Cached screen hitboxes from the most recent layout/render pass. */
  private avatarCards: HangarBox[] = [];
  private themeCards: HangarBox[] = [];
  private shipPlaques: HangarBox[] = [];
  private shipTargets: HangarBox[] = [];
  private cadetTargets: HangarCadetTarget[] = [];
  private navBtn: HangarBox | null = null;
  private partyBtn: HangarBox | null = null;
  private quickFlyBtn: HangarBox | null = null;

  private lastHoveredPilotIdx = -1;

  /** Sums for the board and words for the typing screen: the same ones the game asks. */
  private readonly sums = Array.from({ length: 6 }, () => makeProblem(1));
  private readonly words = WORDS.filter((word) => word.length <= 6);

  constructor(
    private readonly cue: (cue: HangarCue) => void,
    opts?: HangarOptions,
  ) {
    const init = opts?.initialLoadout ?? { pilot: 'nova', theme: 'starlight', ship: 'starhawk' };
    this.loadout = { ...init };
    this.reduceMotion = opts?.reduceMotion ?? false;
    this.onCommit = opts?.onCommitLoadout;
    this.onAnnounce = opts?.onAnnounce;
    this.onPilotVoice = opts?.onPilotVoice;
    this.scenario = buildScenario(opts?.scenarioSeed);
    this.syncFocusFromLoadout();
    this.stage = opts?.hasSavedLoadout ? 'boarding' : 'avatar';
    if (this.stage === 'avatar') {
      const first = PILOTS[this.focusPilot]!;
      this.activeTagline = {
        pilot: first.id,
        text: first.taglines[0].text,
        emote: first.taglines[0].emote,
        age: 0.9,
      };
      this.announceStage();
    }
  }

  /** Roll a fresh randomized hangar scenario for the 7 non-selected squadmates. */
  reseedScenario(seed?: number): void {
    this.scenario = buildScenario(seed);
  }

  /** True while the player is actively choosing their pilot, colour theme or ship. */
  get isPicking(): boolean {
    return this.stage !== 'boarding';
  }

  /** True while the full-squad Dance Party is lighting up the hangar. */
  get dancePartyActive(): boolean {
    return this.dancePartyTimer > 0;
  }

  /** Current interactive 2D layout boxes (used by layout & accessibility tests). */
  get uiBoxes(): HangarUiSnapshot {
    this.ensureGeometry();
    return {
      navBtn: this.navBtn,
      partyBtn: this.partyBtn,
      quickFlyBtn: this.quickFlyBtn,
      avatarCards: this.avatarCards,
      themeCards: this.themeCards,
      shipPlaques: this.shipPlaques,
      shipTargets: this.shipTargets,
      cadetTargets: this.cadetTargets,
    };
  }

  /** Cycle and play the focused/hovered pilot's next signature tagline + matching 3D emote! */
  triggerPilotTagline(pilotId: PilotId, immediate = false): ActivePilotTagline {
    const spec = PILOT_BY_ID[pilotId];
    const slot = this.taglineCursor[pilotId] % spec.taglines.length;
    this.taglineCursor[pilotId] += 1;
    const picked = spec.taglines[slot]!;
    const active: ActivePilotTagline = {
      pilot: pilotId,
      text: picked.text,
      emote: picked.emote,
      age: 0,
    };
    this.activeTagline = active;
    if (immediate) {
      this.pendingVoice = null;
      this.onPilotVoice?.(pilotId, picked.text);
    } else {
      this.pendingVoice = { pilot: pilotId, text: picked.text, wait: 0.08 };
    }
    return active;
  }

  /** Launch (or toggle) a 7-second full-squad Dance Party with disco lights! */
  triggerDanceParty(): void {
    this.dancePartyTimer = this.dancePartyTimer > 0.5 ? 0 : 7;
    this.cue('power');
    if (this.dancePartyTimer > 0) {
      this.onAnnounce?.('Squad dance party in the hangar!');
    }
  }

  /** Click/tap one of the 7 other cadets on the hangar floor to make them react & call out! */
  tapCadetAt(x: number, y: number): boolean {
    const hit = this.cadetTargets.find((c) => hitBox(x, y, c, 8));
    if (!hit) return false;
    const spec = PILOT_BY_ID[hit.id];
    const slotIdx = this.taglineCursor[hit.id] % spec.taglines.length;
    this.taglineCursor[hit.id] += 1;
    const line = spec.taglines[slotIdx]!;
    const callouts = ['HI ACE!', 'WATCH THIS!', 'GO SQUAD!', 'YAY!', 'PIZZA TIME!', 'LET US FLY!'] as const;
    const callout = callouts[(hit.slot + slotIdx) % callouts.length]!;
    this.cadetReaction = {
      id: hit.id,
      slot: hit.slot,
      callout,
      timer: 4,
      worldX: hit.worldX,
      worldZ: hit.worldZ,
    };
    this.cue('key');
    this.onPilotVoice?.(hit.id, line.text);
    this.onAnnounce?.(`${spec.name}: ${line.text}`);
    return true;
  }

  private syncFocusFromLoadout(): void {
    const pi = PILOTS.findIndex((p) => p.id === this.loadout.pilot);
    const ti = THEMES.findIndex((t) => t.id === this.loadout.theme);
    const si = SHIPS.findIndex((s) => s.id === this.loadout.ship);
    this.focusPilot = pi >= 0 ? pi : 0;
    this.focusTheme = ti >= 0 ? ti : 0;
    this.focusShip = si >= 0 ? si : 1;
  }

  private announceStage(): void {
    if (this.stage === 'avatar') {
      const p = PILOTS[this.focusPilot]!;
      this.onAnnounce?.(
        `Step 1 of 3: Choose your pilot. Press 1 to 8, arrows and Space, or F for Quick Fly. Focused: ${p.name}, ${p.tag}.`,
      );
    } else if (this.stage === 'theme') {
      const p = PILOT_BY_ID[this.loadout.pilot];
      const th = THEMES[this.focusTheme]!;
      this.onAnnounce?.(
        `Step 2 of 3: Pick your colour theme for ${p.name}. Press 1 to 6, or arrows and Space. Focused: ${th.name}.`,
      );
    } else if (this.stage === 'ship') {
      const s = SHIPS[this.focusShip]!;
      this.onAnnounce?.(
        `Step 3 of 3: Choose your ship in the hangar. 1 Swift, 2 Starhawk, 3 Bastion. Focused: ${s.name}, ${s.role}, ${s.weapon}.`,
      );
    }
  }

  /** Re-open the 3-step customiser (e.g. when a player clicks the Hangar button or presses `H`). */
  openCustomizer(): void {
    this.reseedScenario();
    this.syncFocusFromLoadout();
    this.stage = 'avatar';
    this.stageAge = 0;
    this.focusSince = this.clock;
    this.lastHoveredPilotIdx = -1;
    const p = PILOTS[this.focusPilot]!;
    this.activeTagline = {
      pilot: p.id,
      text: p.taglines[0].text,
      emote: p.taglines[0].emote,
      age: 0.9,
    };
    this.cue('key');
    this.announceStage();
  }

  /** One-press Quick Fly: commit whichever pilot, theme and ship are currently focused and board immediately. */
  quickFly(): void {
    if (!this.isPicking) return;
    this.pendingVoice = null;
    this.loadout = {
      pilot: PILOTS[this.focusPilot]!.id,
      theme: THEMES[this.focusTheme]!.id,
      ship: SHIPS[this.focusShip]!.id,
    };
    this.finishShipSelection();
  }

  /** Cut to the end of boarding: the fade out, then the cockpit. */
  skip(): void {
    if (this.isPicking) return;
    if (this.t < END - FADE) this.t = END - FADE;
  }

  update(dt: number): void {
    this.clock += dt;
    this.stageAge += dt;
    if (this.activeTagline) {
      this.activeTagline.age += dt;
    }
    if (this.pendingVoice) {
      this.pendingVoice.wait -= dt;
      if (this.pendingVoice.wait <= 0) {
        const pv = this.pendingVoice;
        this.pendingVoice = null;
        if (this.stage === 'avatar') {
          this.onPilotVoice?.(pv.pilot, pv.text);
        }
      }
    }
    if (this.dancePartyTimer > 0) {
      this.dancePartyTimer = Math.max(0, this.dancePartyTimer - dt);
    }
    if (this.cadetReaction) {
      this.cadetReaction.timer -= dt;
      if (this.cadetReaction.timer <= 0) this.cadetReaction = null;
    }

    if (this.isPicking) {
      // Fade in smoothly when opening on the picker, then stay bright while the player chooses.
      this.t = Math.min(this.t + dt, FADE + 0.2);
      return;
    }

    this.t += dt;
    if (!this.rang && this.t > 0.25) {
      this.rang = true;
      this.cue('bell');
    }
    if (this.t > WALK_FROM && this.t < WALK_TO) {
      const taken = Math.floor(((this.t - WALK_FROM) * STRIDES) / Math.PI);
      if (taken > this.steps) {
        this.steps = taken;
        this.cue('step');
      }
    }
    if (!this.shut && this.t > SEATED + 0.3 && this.t < END - FADE) {
      this.shut = true;
      this.cue('canopy');
    }
    if (this.t >= END) this.done = true;
  }

  /** How dark the screen is, 0 to 1: the scene fades in from black and out to it. */
  get curtain(): number {
    if (this.isPicking) {
      return Math.max(1 - this.t / FADE, 0);
    }
    return Math.max(1 - this.t / FADE, (this.t - (END - FADE)) / FADE, 0);
  }

  // ----------------------------------------------------------------- input

  wantsKey(key: string): boolean {
    if (key === 'b' || key === 'B') return true;
    if (!this.isPicking) return false;
    if (key === 'f' || key === 'F') return true;
    if (key === 'Backspace') return this.stage !== 'avatar';
    if (this.stage === 'avatar') return key >= '1' && key <= String(PILOTS.length);
    if (this.stage === 'theme') return key >= '1' && key <= String(THEMES.length);
    return key >= '1' && key <= String(SHIPS.length);
  }

  typeKey(key: string): void {
    if (key === 'b' || key === 'B') {
      this.triggerDanceParty();
      return;
    }
    if (!this.isPicking || this.stageAge < HANGAR_STAGE_GRACE) return;
    if (key === 'f' || key === 'F') {
      this.quickFly();
      return;
    }
    if (key === 'Backspace') {
      this.stepBack();
      return;
    }
    const idx = Number(key) - 1;
    if (Number.isNaN(idx) || idx < 0) return;
    if (this.stage === 'avatar' && PILOTS[idx]) {
      this.focusPilot = idx;
      this.selectPilot(PILOTS[idx]!.id);
    } else if (this.stage === 'theme' && THEMES[idx]) {
      this.focusTheme = idx;
      this.selectTheme(THEMES[idx]!.id);
    } else if (this.stage === 'ship' && SHIPS[idx]) {
      this.focusShip = idx;
      this.selectShip(SHIPS[idx]!.id);
    }
  }

  command(code: string): boolean {
    if (code === 'KeyB') {
      this.triggerDanceParty();
      return true;
    }
    if (code === 'KeyH') {
      if (!this.isPicking) {
        this.openCustomizer();
      } else if (this.stageAge >= HANGAR_STAGE_GRACE) {
        this.quickFly();
      }
      return true;
    }
    if (!this.isPicking) return false;

    const confirm = code === 'Space' || code === 'Enter';
    if (confirm) {
      if (this.stageAge < HANGAR_STAGE_GRACE) return true;
      if (this.stage === 'avatar') this.selectPilot(PILOTS[this.focusPilot]!.id);
      else if (this.stage === 'theme') this.selectTheme(THEMES[this.focusTheme]!.id);
      else if (this.stage === 'ship') this.selectShip(SHIPS[this.focusShip]!.id);
      return true;
    }

    const left = code === 'ArrowLeft' || code === 'KeyA';
    const right = code === 'ArrowRight' || code === 'KeyD';
    const up = code === 'ArrowUp' || code === 'KeyW';
    const down = code === 'ArrowDown' || code === 'KeyS';
    if (!left && !right && !up && !down) return false;

    if (this.stage === 'avatar') {
      const cols = this.avatarCols();
      const total = PILOTS.length;
      let next = this.focusPilot;
      if (left) next = (next + total - 1) % total;
      else if (right) next = (next + 1) % total;
      else if (up) next = (next + total - cols) % total;
      else if (down) next = (next + cols) % total;
      this.focusPilot = next;
      const p = PILOTS[next]!;
      this.loadout.pilot = p.id;
      this.focusSince = this.clock;
      const line = this.triggerPilotTagline(p.id, true);
      this.cue('key');
      this.onAnnounce?.(`${p.name}, ${p.tag}: ${line.text}`);
      return true;
    }

    if (this.stage === 'theme') {
      const cols = this.themeCols();
      const total = THEMES.length;
      let next = this.focusTheme;
      if (left) next = (next + total - 1) % total;
      else if (right) next = (next + 1) % total;
      else if (up) next = (next + total - cols) % total;
      else if (down) next = (next + cols) % total;
      this.focusTheme = next;
      const th = THEMES[next]!;
      this.loadout.theme = th.id;
      this.focusSince = this.clock;
      this.cue('key');
      this.onAnnounce?.(`${th.name}.`);
      return true;
    }

    // stage === 'ship'
    if (left || up) {
      this.focusShip = (this.focusShip + SHIPS.length - 1) % SHIPS.length;
    } else if (right || down) {
      this.focusShip = (this.focusShip + 1) % SHIPS.length;
    }
    const s = SHIPS[this.focusShip]!;
    this.loadout.ship = s.id;
    this.focusSince = this.clock;
    this.cue('key');
    this.onAnnounce?.(`${s.name}, ${s.role}, ${s.weapon}.`);
    return true;
  }

  hover(x: number, y: number): void {
    if (!this.isPicking) return;
    this.ensureGeometry();
    if (this.stage === 'avatar') {
      const idx = this.avatarCards.findIndex((b) => hitBox(x, y, b, 2));
      if (idx < 0) {
        this.lastHoveredPilotIdx = -1;
        return;
      }
      if (idx !== this.lastHoveredPilotIdx) {
        this.lastHoveredPilotIdx = idx;
        this.focusPilot = idx;
        const p = PILOTS[idx]!;
        this.loadout.pilot = p.id;
        this.focusSince = this.clock;
        this.triggerPilotTagline(p.id, false);
        this.cue('key');
      }
      return;
    }
    if (this.stage === 'theme') {
      const idx = this.themeCards.findIndex((b) => hitBox(x, y, b, 2));
      if (idx >= 0 && idx !== this.focusTheme) {
        this.focusTheme = idx;
        this.loadout.theme = THEMES[idx]!.id;
        this.focusSince = this.clock;
      }
      return;
    }
    // stage === 'ship'
    const plaqueIdx = this.shipPlaques.findIndex((b) => hitBox(x, y, b, 4));
    const craftIdx = plaqueIdx >= 0 ? plaqueIdx : this.shipTargets.findIndex((b) => hitBox(x, y, b, 6));
    if (craftIdx >= 0 && craftIdx !== this.focusShip) {
      this.focusShip = craftIdx;
      this.loadout.ship = SHIPS[craftIdx]!.id;
      this.focusSince = this.clock;
    }
  }

  /**
   * Handle a click or tap at (x, y).
   * Returns true whenever a picker step is active (or when tapping a cadet/party button during boarding)
   * so interactive clicks never accidentally skip the hangar.
   */
  pick(x: number, y: number): boolean {
    if (!this.isPicking) {
      // During boarding, tapping one of the 7 squadmates makes them react instead of skipping!
      return this.tapCadetAt(x, y);
    }
    if (this.stageAge < HANGAR_STAGE_GRACE) return true;
    this.ensureGeometry();

    if (this.navBtn && hitBox(x, y, this.navBtn, 6)) {
      this.stepBack();
      return true;
    }
    if (this.partyBtn && hitBox(x, y, this.partyBtn, 6)) {
      this.triggerDanceParty();
      return true;
    }
    if (this.quickFlyBtn && hitBox(x, y, this.quickFlyBtn, 6)) {
      this.quickFly();
      return true;
    }

    if (this.stage === 'avatar') {
      const idx = this.avatarCards.findIndex((b) => hitBox(x, y, b, 4));
      if (idx >= 0) {
        this.focusPilot = idx;
        this.selectPilot(PILOTS[idx]!.id);
      }
      return true;
    }

    if (this.stage === 'theme') {
      const idx = this.themeCards.findIndex((b) => hitBox(x, y, b, 4));
      if (idx >= 0) {
        this.focusTheme = idx;
        this.selectTheme(THEMES[idx]!.id);
      }
      return true;
    }

    // stage === 'ship': tap a >= 44px 2D bay stat card (or click the 3D ship directly on desktop),
    // or click any of the 7 squadmates on the hangar floor to make them react!
    const plaqueIdx = this.shipPlaques.findIndex((b) => hitBox(x, y, b, 6));
    const craftIdx = plaqueIdx >= 0 ? plaqueIdx : this.shipTargets.findIndex((b) => hitBox(x, y, b, 10));
    if (craftIdx >= 0) {
      this.focusShip = craftIdx;
      this.selectShip(SHIPS[craftIdx]!.id);
      return true;
    }
    this.tapCadetAt(x, y);
    return true;
  }

  private stepBack(): void {
    if (this.stage === 'theme') {
      this.stage = 'avatar';
      this.stageAge = 0;
      this.focusSince = this.clock;
      this.lastHoveredPilotIdx = -1;
      this.cue('key');
      this.announceStage();
    } else if (this.stage === 'ship') {
      this.stage = 'theme';
      this.stageAge = 0;
      this.focusSince = this.clock;
      this.cue('key');
      this.announceStage();
    }
  }

  private selectPilot(id: PilotId): void {
    this.pendingVoice = null;
    this.loadout.pilot = id;
    this.syncFocusFromLoadout();
    this.stage = 'theme';
    this.stageAge = 0;
    this.focusSince = this.clock;
    this.cue('power');
    this.announceStage();
  }

  private selectTheme(id: ThemeId): void {
    this.loadout.theme = id;
    this.syncFocusFromLoadout();
    this.stage = 'ship';
    this.stageAge = 0;
    this.focusSince = this.clock;
    this.cue('power');
    this.announceStage();
  }

  private selectShip(id: ShipId): void {
    this.loadout.ship = id;
    this.syncFocusFromLoadout();
    this.finishShipSelection();
  }

  private finishShipSelection(): void {
    const pilot = PILOT_BY_ID[this.loadout.pilot];
    const theme = THEME_BY_ID[this.loadout.theme];
    const ship = SHIP_BY_ID[this.loadout.ship];
    this.onCommit?.({ ...this.loadout });
    this.cue('power');
    this.onAnnounce?.(`Boarding ${ship.name} as ${pilot.name} in ${theme.name} colours.`);
    if (this.reduceMotion) {
      this.done = true;
      return;
    }
    // Start walking across the hangar floor to the chosen ship's boarding ladder!
    this.stage = 'boarding';
    this.t = WALK_FROM;
    this.steps = 0;
    this.shut = false;
  }

  // ----------------------------------------------------------------- camera & layout

  private avatarCols(): number {
    return this.w >= Math.max(540, this.h * 0.85) ? 4 : 2;
  }

  private themeCols(): number {
    return this.w >= 540 ? 3 : 2;
  }

  /** Point the camera for this frame. Centres all 3 bays during selection, then tracks the chosen bay as the pilot boards. */
  private aim(w: number, h: number): void {
    this.w = w;
    this.h = h;
    const portraitExtraZ = h > w ? clamp((h / Math.max(1, w) - 1) * 5.2, 0, 6.2) : 0;
    const shipSpec = SHIP_BY_ID[this.loadout.ship];

    if (this.stage !== 'boarding') {
      // Wide framing so Bays 1, 2 and 3 sit comfortably inside both 16:9 desktops and narrow portrait phones.
      this.cx = 0;
      this.cy = 5.1;
      this.cz = -11.8 - portraitExtraZ;
      const yaw = 0;
      const pitch = -0.085;
      this.cosYaw = Math.cos(yaw);
      this.sinYaw = Math.sin(yaw);
      this.cosPitch = Math.cos(pitch);
      this.sinPitch = Math.sin(pitch);
      this.focal = Math.max(0.88 * Math.min(w, h * 1.25), 0.44 * h);
      this.eye = h * (this.stage === 'ship' ? 0.45 : 0.5);
      return;
    }

    const along = smooth(clamp((this.t - WALK_FROM) / (END - WALK_FROM), 0, 1));
    const targetX = shipSpec.bay.x * 0.42;
    const targetYaw = clamp(shipSpec.bay.x * 0.014, -0.12, 0.12);
    const yaw = lerp(0, targetYaw, along);
    const pitch = lerp(-0.085, -0.055, along);
    this.cx = lerp(0, targetX, along);
    this.cy = lerp(5.1, 4.6, along);
    this.cz = lerp(-11.8 - portraitExtraZ, -8.2 - portraitExtraZ * 0.55, along);
    this.cosYaw = Math.cos(yaw);
    this.sinYaw = Math.sin(yaw);
    this.cosPitch = Math.cos(pitch);
    this.sinPitch = Math.sin(pitch);
    this.focal = Math.max(0.88 * Math.min(w, h * 1.25), 0.46 * h);
    this.eye = lerp(h * 0.45, h * 0.52, along);
  }

  private ensureGeometry(): void {
    this.aim(this.w, this.h);
    const ins = this.lastInset;
    const left = ins.left + 12;
    const right = this.w - ins.right - 12;
    const top = ins.top + 12;
    const bottom = this.h - ins.bottom - 12;
    const availW = Math.max(240, right - left);

    // Sub-bar starts strictly below the 44px top-right `.arcade-controls` toolbar so nothing overlaps on 320px phones.
    const uiTop = top + 50;
    const wideBar = this.stage === 'ship' ? availW >= 680 : availW >= 560;

    if (this.isPicking) {
      this.navBtn = this.stage === 'avatar' ? null : { x: left, y: uiTop, w: 84, h: 44 };
      this.partyBtn = this.stage === 'ship' ? { x: left + 90, y: uiTop, w: 84, h: 44 } : null;
      this.quickFlyBtn = { x: right - 118, y: uiTop, w: 118, h: 44 };
    } else {
      this.navBtn = null;
      this.partyBtn = null;
      this.quickFlyBtn = null;
    }

    const headerTop = wideBar ? uiTop + 4 : uiTop + 52;

    if (this.stage === 'avatar') {
      const cols = this.avatarCols();
      const rows = Math.ceil(PILOTS.length / cols);
      const gap = this.w < 460 ? 8 : 12;
      const gridTop = headerTop + (this.h < 500 ? 34 : 44);
      const taglineReserve = this.h < 500 ? 40 : 48;
      const gridBottom = bottom - taglineReserve;
      const maxCardW = cols === 4 ? 148 : 164;
      const cw = Math.min(maxCardW, (availW - gap * (cols - 1)) / cols);
      const ch = clamp((gridBottom - gridTop - gap * (rows - 1)) / rows, 68, cols === 4 ? 152 : 120);
      const totalW = cw * cols + gap * (cols - 1);
      const x0 = left + (availW - totalW) / 2;
      const totalH = ch * rows + gap * (rows - 1);
      const y0 = gridTop + Math.max(0, (gridBottom - gridTop - totalH) * 0.25);
      this.avatarCards = PILOTS.map((_, i) => ({
        x: x0 + (i % cols) * (cw + gap),
        y: y0 + Math.floor(i / cols) * (ch + gap),
        w: cw,
        h: ch,
      }));
    } else {
      this.avatarCards = [];
    }

    if (this.stage === 'theme') {
      const cols = this.themeCols();
      const rows = Math.ceil(THEMES.length / cols);
      const gap = this.w < 460 ? 8 : 12;
      const showPreview = this.h >= 540;
      const previewH = showPreview ? (this.h >= 680 ? 82 : 64) : 0;
      const gridTop = headerTop + (this.h < 500 ? 34 : 42) + (showPreview ? previewH + 12 : 0);
      const gridBottom = bottom - 24;
      const maxCardW = cols === 3 ? 176 : 180;
      const cw = Math.min(maxCardW, (availW - gap * (cols - 1)) / cols);
      const ch = clamp((gridBottom - gridTop - gap * (rows - 1)) / rows, 62, 112);
      const totalW = cw * cols + gap * (cols - 1);
      const x0 = left + (availW - totalW) / 2;
      const totalH = ch * rows + gap * (rows - 1);
      const y0 = gridTop + Math.max(0, (gridBottom - gridTop - totalH) * 0.3);
      this.themeCards = THEMES.map((_, i) => ({
        x: x0 + (i % cols) * (cw + gap),
        y: y0 + Math.floor(i / cols) * (ch + gap),
        w: cw,
        h: ch,
      }));
    } else {
      this.themeCards = [];
    }

    if (this.stage === 'ship') {
      // 3D ship bounding boxes projected directly from their hangar bays:
      this.shipTargets = SHIPS.map((ship) => {
        if (!this.flat(ship.bay.x, 1.35, ship.bay.z)) {
          return { x: -999, y: -999, w: 0, h: 0 };
        }
        const spanW = Math.max(68, (this.focal * 6.8) / this.sd);
        const spanH = Math.max(54, (this.focal * 3.8) / this.sd);
        return {
          x: this.sx - spanW / 2,
          y: this.sy - spanH * 0.55,
          w: spanW,
          h: spanH,
        };
      });

      // Three crisp side-by-side 2D bay cards (strictly >= 52px tall on every phone and desktop):
      const gap = this.w < 440 ? 6 : 12;
      const maxPlaqueW = 196;
      const pw = Math.max(88, Math.min(maxPlaqueW, (availW - gap * 2) / 3));
      const ph = Math.max(52, this.h < 480 ? 84 : 102);
      const totalW = pw * 3 + gap * 2;
      const x0 = left + (availW - totalW) / 2;
      const py = bottom - ph - (this.h < 480 ? 18 : 24);
      this.shipPlaques = SHIPS.map((_, i) => ({
        x: x0 + i * (pw + gap),
        y: py,
        w: pw,
        h: ph,
      }));
    } else {
      this.shipTargets = [];
      this.shipPlaques = [];
    }
  }

  /** Flatten a point of the hangar onto the screen (into sx, sy; sd is its distance). False if behind camera. */
  private flat(x: number, y: number, z: number): boolean {
    const dx = x - this.cx;
    const dy = y - this.cy;
    const dz = z - this.cz;
    const x1 = dx * this.cosYaw - dz * this.sinYaw;
    const z1 = dx * this.sinYaw + dz * this.cosYaw;
    const depth = z1 * this.cosPitch + dy * this.sinPitch;
    if (depth < NEAR) return false;
    this.sd = depth;
    this.sx = this.w / 2 + (this.focal * x1) / depth;
    this.sy = this.eye - (this.focal * (dy * this.cosPitch - z1 * this.sinPitch)) / depth;
    return true;
  }

  private seg(ax: number, ay: number, az: number, bx: number, by: number, bz: number): void {
    const ctx = this.ctx!;
    if (!this.flat(ax, ay, az)) return;
    const x = this.sx;
    const y = this.sy;
    if (!this.flat(bx, by, bz)) return;
    ctx.moveTo(x, y);
    ctx.lineTo(this.sx, this.sy);
  }

  private box(x: number, y: number, z: number, wide: number, tall: number, deep: number): void {
    box3d((ax, ay, az, bx, by, bz) => this.seg(ax, ay, az, bx, by, bz), x, y, z, wide, tall, deep, true);
  }

  private label(text: string, x: number, y: number, z: number, tall: number): void {
    if (!this.flat(x, y, z)) return;
    const size = (this.focal * tall) / this.sd;
    if (size >= 2.5) traceText(this.ctx!, text, this.sx, this.sy, size, 'center');
  }

  /** The hole the stars and planets show through: the hangar door. game.ts clips the sky to this path. */
  clipSky = (ctx: CanvasRenderingContext2D): void => {
    const corners = [[-DOOR_HALF, 0], [-DOOR_HALF, DOOR_TOP], [DOOR_HALF, DOOR_TOP], [DOOR_HALF, 0]] as const;
    corners.forEach(([x, y], i) => {
      if (!this.flat(x, y, DEPTH)) return;
      if (i) ctx.lineTo(this.sx, this.sy);
      else ctx.moveTo(this.sx, this.sy);
    });
    ctx.closePath();
  };

  /** Get ready to be asked for the door's outline, before anything is drawn this frame. */
  layout(w: number, h: number): void {
    this.aim(w, h);
  }

  // ---------------------------------------------------------------- people & squad antics

  private aimVec(dir: [number, number, number], len: number): [number, number, number] {
    const m = Math.hypot(dir[0], dir[1], dir[2]) || 1;
    return [(dir[0] / m) * len, (dir[1] / m) * len, (dir[2] / m) * len];
  }

  private draw(p: Pose, part: 'body' | 'limbs' | 'accent'): void {
    const s = p.scale;
    const cos = Math.cos(p.face);
    const sin = Math.sin(p.face);
    const lie = Boolean(p.lying);
    const L = (ax: number, ay: number, az: number, bx: number, by: number, bz: number): void => {
      const y1 = lie ? 0.56 + az * 0.88 : ay;
      const z1 = lie ? (ay - 0.96) * 0.96 : az;
      const y2 = lie ? 0.56 + bz * 0.88 : by;
      const z2 = lie ? (by - 0.96) * 0.96 : bz;
      this.seg(
        p.x + (ax * cos + z1 * sin) * s,
        p.y + y1 * s,
        p.z + (-ax * sin + z1 * cos) * s,
        p.x + (bx * cos + z2 * sin) * s,
        p.y + y2 * s,
        p.z + (-bx * sin + z2 * cos) * s,
      );
    };

    const squat = p.squat ?? 0;
    const drop = (p.seated ? 0.4 : 0) + squat;
    const hipX = p.hipShiftX ?? 0;
    const shX = -hipX * 0.35;
    const hip = 0.94 - drop;
    const shoulder = 1.46 - drop * 0.92;
    const chin = shoulder + 0.11;
    const crown = chin + 0.3;
    const pid = p.pilotId;
    const hat = pid ? PILOT_BY_ID[pid].hangarHat : p.hat;

    if (part === 'body') {
      for (const z of [0.1, -0.1]) {
        L(shX - 0.25, shoulder, z, shX + 0.25, shoulder, z);
        L(shX + 0.25, shoulder, z, hipX + 0.16, hip, z);
        L(hipX + 0.16, hip, z, hipX - 0.16, hip, z);
        L(hipX - 0.16, hip, z, shX - 0.25, shoulder, z);
      }
      for (const [x, y] of [
        [shX - 0.25, shoulder],
        [shX + 0.25, shoulder],
        [hipX + 0.16, hip],
        [hipX - 0.16, hip],
      ] as const) {
        L(x, y, 0.1, x, y, -0.1);
      }

      // Bevelled low-poly 3D head shell:
      L(shX, shoulder, 0, shX, chin, 0);
      const midY = (chin + crown) * 0.5;
      for (const z of [0.135, -0.125]) {
        L(shX - 0.1, chin, z, shX + 0.1, chin, z);
        L(shX + 0.1, chin, z, shX + 0.155, midY, z * 0.92);
        L(shX + 0.155, midY, z * 0.92, shX + 0.12, crown, z * 0.88);
        L(shX + 0.12, crown, z * 0.88, shX - 0.12, crown, z * 0.88);
        L(shX - 0.12, crown, z * 0.88, shX - 0.155, midY, z * 0.92);
        L(shX - 0.155, midY, z * 0.92, shX - 0.1, chin, z);
      }
      for (const [x, y] of [
        [shX - 0.1, chin],
        [shX + 0.1, chin],
        [shX + 0.155, midY],
        [shX - 0.155, midY],
        [shX + 0.12, crown],
        [shX - 0.12, crown],
      ] as const) {
        L(x, y, 0.12, x, y, -0.11);
      }

      // Generic crew hats when `pilotId` is not set (teacher & mechanics):
      if (!pid) {
        if (hat === 'helmet') {
          L(shX - 0.1, crown - 0.08, 0.14, shX + 0.1, crown - 0.08, 0.14);
          L(shX + 0.1, crown - 0.08, 0.14, shX + 0.1, crown - 0.17, 0.14);
          L(shX + 0.1, crown - 0.17, 0.14, shX - 0.1, crown - 0.17, 0.14);
          L(shX - 0.1, crown - 0.17, 0.14, shX - 0.1, crown - 0.08, 0.14);
        } else if (hat === 'cap') {
          L(shX - 0.15, crown - 0.03, 0.13, shX - 0.12, crown - 0.03, 0.3);
          L(shX - 0.12, crown - 0.03, 0.3, shX + 0.12, crown - 0.03, 0.3);
          L(shX + 0.12, crown - 0.03, 0.3, shX + 0.15, crown - 0.03, 0.13);
        }
      }

      if (p.pack) {
        const px0 = (shX + hipX) * 0.5 - 0.15;
        const px1 = (shX + hipX) * 0.5 + 0.15;
        for (const [x, y, x2, y2] of [
          [px0, hip + 0.14, px1, hip + 0.14],
          [px1, hip + 0.14, px1, shoulder - 0.04],
          [px1, shoulder - 0.04, px0, shoulder - 0.04],
          [px0, shoulder - 0.04, px0, hip + 0.14],
        ] as const) {
          L(x, y, -0.24, x2, y2, -0.24);
          L(x, y, -0.1, x, y, -0.24);
        }
      }
      return;
    }

    if (part === 'accent') {
      // Expressive eyes + mouth on the front of the 3D head:
      const eyeY = chin + 0.17;
      const fz = 0.145;
      for (const side of [-1, 1]) {
        const ex = shX + side * 0.062;
        if (p.sleeping) {
          L(ex - 0.026, eyeY - 0.01, fz, ex + 0.026, eyeY - 0.01, fz);
        } else if (p.happy) {
          L(ex - 0.026, eyeY - 0.012, fz, ex, eyeY + 0.018, fz);
          L(ex, eyeY + 0.018, fz, ex + 0.026, eyeY - 0.012, fz);
        } else {
          L(ex - 0.02, eyeY, fz, ex + 0.02, eyeY, fz);
          L(ex, eyeY - 0.016, fz, ex, eyeY + 0.016, fz);
        }
      }
      if (!p.sleeping && pid !== 'owl' && pid !== 'fox' && pid !== 'wolf') {
        const my = chin + 0.075;
        L(shX - 0.045, my + (p.happy ? 0.012 : 0), fz, shX, my - 0.014, fz);
        L(shX, my - 0.014, fz, shX + 0.045, my + (p.happy ? 0.012 : 0), fz);
      }

      const wag = Math.sin(p.tailPhase ?? 0) * 0.18;

      if (hat === 'visor') {
        // Nova: swept bangs + glowing wrap-around brow visor.
        L(shX - 0.13, crown - 0.05, 0.155, shX + 0.13, crown - 0.05, 0.155);
        L(shX + 0.13, crown - 0.05, 0.155, shX + 0.11, crown - 0.13, 0.155);
        L(shX + 0.11, crown - 0.13, 0.155, shX - 0.11, crown - 0.13, 0.155);
        L(shX - 0.11, crown - 0.13, 0.155, shX - 0.13, crown - 0.05, 0.155);
        L(shX - 0.12, crown, 0.08, shX + 0.04, crown + 0.09, 0.12);
        L(shX + 0.04, crown + 0.09, 0.12, shX + 0.14, crown - 0.02, 0.09);
      } else if (hat === 'goggles') {
        // Leo: bold 3-spike hair crown + twin-lens forehead flight goggles.
        L(shX - 0.11, crown, 0.02, shX - 0.05, crown + 0.14, 0.07);
        L(shX - 0.05, crown + 0.14, 0.07, shX, crown + 0.02, 0.03);
        L(shX, crown + 0.02, 0.03, shX + 0.06, crown + 0.15, 0.06);
        L(shX + 0.06, crown + 0.15, 0.06, shX + 0.12, crown, 0.02);
        for (const side of [-1, 1]) {
          const gx = shX + side * 0.065;
          L(gx - 0.045, crown - 0.02, 0.155, gx + 0.045, crown - 0.02, 0.155);
          L(gx + 0.045, crown - 0.02, 0.155, gx + 0.045, crown - 0.08, 0.155);
          L(gx + 0.045, crown - 0.08, 0.155, gx - 0.045, crown - 0.08, 0.155);
          L(gx - 0.045, crown - 0.08, 0.155, gx - 0.045, crown - 0.02, 0.155);
        }
      } else if (hat === 'puffs') {
        // Maya: big twin 3D low-poly space-puffs + star hairpins.
        for (const side of [-1, 1]) {
          const bx = shX + side * 0.13;
          const ox = shX + side * 0.27;
          L(bx, crown - 0.02, 0.04, ox, crown + 0.09, 0.02);
          L(ox, crown + 0.09, 0.02, ox, crown - 0.08, 0.05);
          L(ox, crown - 0.08, 0.05, bx, crown - 0.09, -0.02);
          L(bx, crown - 0.02, -0.05, ox, crown + 0.06, -0.06);
          L(ox, crown + 0.06, -0.06, ox, crown + 0.09, 0.02);
        }
      } else if (hat === 'cap') {
        // Kai: comet cap visor + wrap-around ear-cup headset & boom mic.
        L(shX - 0.14, crown - 0.02, 0.13, shX - 0.11, crown - 0.03, 0.29);
        L(shX - 0.11, crown - 0.03, 0.29, shX + 0.11, crown - 0.03, 0.29);
        L(shX + 0.11, crown - 0.03, 0.29, shX + 0.14, crown - 0.02, 0.13);
        L(shX + 0.16, (chin + crown) * 0.5, 0.02, shX + 0.16, chin + 0.07, 0.08);
        L(shX + 0.16, chin + 0.07, 0.08, shX + 0.05, chin + 0.07, 0.165);
      } else if (hat === 'fox') {
        // Rusty the Space Fox: tall pointed 3D fox ears, pointed snout & wagging 3D fox tail!
        for (const side of [-1, 1]) {
          L(shX + side * 0.04, crown, 0.04, shX + side * 0.17, crown + 0.23, 0.02);
          L(shX + side * 0.17, crown + 0.23, 0.02, shX + side * 0.14, crown - 0.01, -0.05);
          L(shX + side * 0.08, crown, 0.05, shX + side * 0.15, crown + 0.18, 0.03);
          // Cheek fluff tufts:
          L(shX + side * 0.15, chin + 0.09, 0.06, shX + side * 0.23, chin + 0.06, 0.04);
          L(shX + side * 0.23, chin + 0.06, 0.04, shX + side * 0.13, chin + 0.03, 0.08);
        }
        // Pointed 3D pyramid snout:
        L(shX - 0.07, chin + 0.12, 0.14, shX, chin + 0.09, 0.31);
        L(shX + 0.07, chin + 0.12, 0.14, shX, chin + 0.09, 0.31);
        L(shX, chin + 0.03, 0.14, shX, chin + 0.09, 0.31);
        if (!p.seated && !lie) {
          const tx = hipX + wag;
          L(hipX, hip + 0.04, -0.12, tx * 0.6 - 0.08, hip + 0.14, -0.34);
          L(hipX, hip + 0.04, -0.12, tx * 0.6 + 0.08, hip + 0.14, -0.34);
          L(tx * 0.6 - 0.08, hip + 0.14, -0.34, tx, hip + 0.24, -0.54);
          L(tx * 0.6 + 0.08, hip + 0.14, -0.34, tx, hip + 0.24, -0.54);
        }
      } else if (hat === 'cat') {
        // Mochi the Star Cat: wide feline ears, 3D side whiskers & swaying cat tail!
        for (const side of [-1, 1]) {
          L(shX + side * 0.05, crown, 0.04, shX + side * 0.19, crown + 0.17, 0.03);
          L(shX + side * 0.19, crown + 0.17, 0.03, shX + side * 0.15, crown - 0.02, -0.04);
          // 3D whiskers:
          L(shX + side * 0.11, chin + 0.11, 0.145, shX + side * 0.27, chin + 0.13, 0.12);
          L(shX + side * 0.11, chin + 0.08, 0.145, shX + side * 0.26, chin + 0.07, 0.12);
        }
        if (!p.seated && !lie) {
          const tx = hipX + wag * 0.9;
          L(hipX, hip + 0.04, -0.11, hipX + wag * 0.4, hip + 0.22, -0.32);
          L(hipX + wag * 0.4, hip + 0.22, -0.32, tx, hip + 0.44, -0.28);
        }
      } else if (hat === 'wolf') {
        // Koda the Astro Pup: floppy-tip pup ears, blocky 3D muzzle & fast-wagging pup tail!
        for (const side of [-1, 1]) {
          L(shX + side * 0.06, crown, 0.04, shX + side * 0.15, crown + 0.16, 0.04);
          L(shX + side * 0.15, crown + 0.16, 0.04, shX + side * 0.22, crown + 0.07, 0.09);
          L(shX + side * 0.22, crown + 0.07, 0.09, shX + side * 0.14, crown, -0.02);
        }
        // Blocky 3D pup snout:
        L(shX - 0.065, chin + 0.12, 0.14, shX - 0.05, chin + 0.11, 0.27);
        L(shX + 0.065, chin + 0.12, 0.14, shX + 0.05, chin + 0.11, 0.27);
        L(shX - 0.05, chin + 0.11, 0.27, shX + 0.05, chin + 0.11, 0.27);
        L(shX - 0.05, chin + 0.11, 0.27, shX, chin + 0.04, 0.25);
        L(shX + 0.05, chin + 0.11, 0.27, shX, chin + 0.04, 0.25);
        if (!p.seated && !lie) {
          const tx = hipX + Math.sin((p.tailPhase ?? 0) * 1.5) * 0.22;
          L(hipX, hip + 0.05, -0.11, tx, hip + 0.28, -0.36);
        }
      } else if (hat === 'owl') {
        // Pip the Sky Owl: feathered horn-tufts, round 3D spectacle rings & diamond beak!
        for (const side of [-1, 1]) {
          L(shX + side * 0.06, crown, 0.04, shX + side * 0.2, crown + 0.16, 0.02);
          L(shX + side * 0.2, crown + 0.16, 0.02, shX + side * 0.13, crown - 0.02, 0.04);
          // Round spectacle ring around each eye:
          const gx = shX + side * 0.064;
          L(gx - 0.045, eyeY + 0.038, 0.152, gx + 0.045, eyeY + 0.038, 0.152);
          L(gx + 0.045, eyeY + 0.038, 0.152, gx + 0.045, eyeY - 0.038, 0.152);
          L(gx + 0.045, eyeY - 0.038, 0.152, gx - 0.045, eyeY - 0.038, 0.152);
          L(gx - 0.045, eyeY - 0.038, 0.152, gx - 0.045, eyeY + 0.038, 0.152);
        }
        // 3D diamond owl beak:
        L(shX - 0.035, chin + 0.13, 0.15, shX, chin + 0.1, 0.27);
        L(shX + 0.035, chin + 0.13, 0.15, shX, chin + 0.1, 0.27);
        L(shX, chin + 0.06, 0.15, shX, chin + 0.1, 0.27);
      }
      return;
    }

    // part === 'limbs'
    const stride = p.stride;
    const spread = p.legSpread ?? 0;
    for (const side of [-1, 1]) {
      const hx = hipX + side * 0.11;
      if (p.seated) {
        L(hx, hip, 0, hx, hip, 0.44);
        L(hx, hip, 0.44, hx, hip - 0.5, 0.48);
        L(hx, hip - 0.5, 0.48, hx, hip - 0.5, 0.64);
        continue;
      }
      const kick = side < 0 ? (p.legKickL ?? 0) : (p.legKickR ?? 0);
      if (spread > 0.001 || kick > 0.001 || squat > 0.01) {
        const outX = side * Math.sin(spread) * 0.46;
        const kx = hx + outX * 0.55;
        const ky = hip - Math.cos(spread) * (0.45 - squat * 0.35) + kick * 0.22;
        const kz = squat * 0.55 + kick * 0.38;
        const fx = hx + outX;
        const fy = Math.max(0, ky - (0.47 - squat * 0.35) + kick * 0.18);
        const fz = kick * 0.52;
        L(hx, hip, 0, kx, ky, kz);
        L(kx, ky, kz, fx, fy, fz);
        L(fx, fy, fz, fx, fy, fz + 0.16);
        continue;
      }
      const phase = stride === null ? 0 : stride + (side > 0 ? Math.PI : 0);
      const swing = stride === null ? 0 : Math.sin(phase) * (p.climbing ? 0.75 : 0.55);
      const bend = stride === null ? 0.04 : 0.2 + (p.climbing ? 0.9 : 0.5) * Math.max(0, Math.cos(phase));
      const kx = hx;
      const ky = hip - Math.cos(swing) * 0.47;
      const kz = Math.sin(swing) * 0.47;
      const fy = ky - Math.cos(swing - bend) * 0.47;
      const fz = kz + Math.sin(swing - bend) * 0.47;
      L(hx, hip, 0, kx, ky, kz);
      L(kx, ky, kz, kx, fy, fz);
      L(kx, fy, fz, kx, fy, fz + 0.16);
    }

    for (const side of [-1, 1]) {
      const ax = shX + side * 0.29;
      const ay = shoulder - 0.04;
      const customArm = side < 0 ? p.armL : p.armR;
      if (customArm) {
        const [ux, uy, uz] = this.aimVec(customArm.upper, 0.3);
        const [fx, fy, fz] = this.aimVec(customArm.fore, 0.28);
        const ex = ax + ux;
        const ey = ay + uy;
        const ez = uz;
        const hx = ex + fx;
        const hy = ey + fy;
        const hz = ez + fz;
        L(ax, ay, 0, ex, ey, ez);
        L(ex, ey, ez, hx, hy, hz);
        if (side > 0 && p.tool) {
          const [tx, ty, tz] = this.aimVec(customArm.fore, p.tool);
          L(hx, hy, hz, hx + tx, hy + ty, hz + tz);
        }
        continue;
      }

      let raise: number;
      if (p.climbing) raise = 2 + Math.sin((stride ?? 0) + (side > 0 ? 0 : Math.PI)) * 0.45;
      else if (side > 0 && p.reach > 0) raise = p.reach * Math.PI;
      else if (p.seated) raise = 0.9;
      else raise = stride === null ? 0.05 : -Math.sin(stride + (side > 0 ? Math.PI : 0)) * 0.5;
      const ex = ax;
      const ey = ay - Math.cos(raise) * 0.3;
      const ez = Math.sin(raise) * 0.3;
      const fore = raise + (p.seated ? 0.5 : 0.35);
      const hy = ey - Math.cos(fore) * 0.28;
      const hz = ez + Math.sin(fore) * 0.28;
      L(ax, ay, 0, ex, ey, ez);
      L(ex, ey, ez, ex, hy, hz);
      if (side > 0 && p.tool) L(ex, hy, hz, ex, hy - Math.cos(fore) * p.tool, hz + Math.sin(fore) * p.tool);
    }
  }

  private people(ink: HangarInk, color: string, alpha: number, glow: boolean, poses: readonly Pose[]): void {
    ink(color, alpha, 1.1, () => poses.forEach((p) => this.draw(p, 'body')), glow);
    ink(color, alpha, 2, () => poses.forEach((p) => this.draw(p, 'limbs')), glow);
  }

  /** Draw a named pilot in 3D with their multi-colour low-poly head, ears/visor/snout/tail, and suit! */
  private drawPilot(
    ink: HangarInk,
    spec: PilotSpec,
    suitColor: string,
    accentColor: string,
    alpha: number,
    glow: boolean,
    pose: Pose,
  ): void {
    const withId: Pose = { ...pose, pilotId: spec.id, hat: spec.hangarHat };
    ink(suitColor, alpha, 1.15, () => this.draw(withId, 'body'), glow);
    ink(suitColor, alpha, 1.95, () => this.draw(withId, 'limbs'), glow);
    ink(accentColor, Math.min(1, alpha + 0.14), 1.45, () => this.draw(withId, 'accent'), glow);
  }

  /** Build a celebratory cadet dance pose (`wave`, `boogie`, `starhop`, or `hype`) at `x, z`. */
  private cadetDancePose(
    move: DanceMove,
    x: number,
    z: number,
    face: number,
    animTime: number,
    phase: number,
  ): Pose {
    const t = animTime + phase;
    if (move === 'wave') {
      // Cosmic Wave: smooth overhead aurora-ribbon wave flowing across both arms.
      const b = t * 5.8;
      const s = Math.sin(b);
      const c = Math.cos(b);
      return person({
        x,
        z,
        face,
        pack: true,
        happy: true,
        tailPhase: b,
        hipShiftX: s * 0.13,
        squat: 0.06 + 0.06 * Math.abs(c),
        legSpread: 0.18,
        armL: { upper: [-0.52, 0.38 + s * 0.42, 0.22], fore: [-0.24 + c * 0.38, 0.68 + c * 0.34, 0.28] },
        armR: { upper: [0.52, 0.38 - s * 0.42, 0.22], fore: [0.24 + c * 0.38, 0.68 - c * 0.34, 0.28] },
      });
    }
    if (move === 'boogie') {
      // Starlight Boogie: upbeat disco knee-bounce alternating skyward star points with hand-on-hip.
      const b = t * 6.4;
      const s = Math.sin(b);
      const c = Math.cos(b);
      const liftL = Math.max(0, -s);
      const liftR = Math.max(0, s);
      return person({
        x,
        z,
        face: face + s * 0.14,
        pack: true,
        happy: true,
        tailPhase: b,
        hipShiftX: -s * 0.14,
        squat: 0.09 + 0.1 * Math.abs(c),
        legSpread: 0.22,
        armL: {
          upper: [-0.46 - liftL * 0.14, -0.34 + liftL * 1.18, 0.18 + liftL * 0.16],
          fore: [0.22 - liftL * 0.56, -0.26 + liftL * 1.18, 0.22 + liftL * 0.14],
        },
        armR: {
          upper: [0.46 + liftR * 0.14, -0.34 + liftR * 1.18, 0.18 + liftR * 0.16],
          fore: [-0.22 + liftR * 0.56, -0.26 + liftR * 1.18, 0.22 + liftR * 0.14],
        },
      });
    }
    if (move === 'starhop') {
      // Zero-G Star Hop: buoyant low-gravity hop with wide victory-V arms and cheerful heel kicks.
      const b = t * 5.6;
      const s = Math.sin(b);
      const hop = Math.abs(s);
      return person({
        x,
        z,
        y: hop * 0.22,
        face,
        pack: true,
        happy: true,
        tailPhase: b,
        legSpread: 0.16 + 0.14 * hop,
        legKickL: Math.max(0, s) * 0.52,
        legKickR: Math.max(0, -s) * 0.52,
        armL: { upper: [-0.58 - hop * 0.18, 0.52 + hop * 0.34, 0.2], fore: [-0.44 - hop * 0.2, 0.84 + hop * 0.16, 0.22] },
        armR: { upper: [0.58 + hop * 0.18, 0.52 + hop * 0.34, 0.2], fore: [0.44 + hop * 0.2, 0.84 + hop * 0.16, 0.22] },
      });
    }
    // 'hype' — Cadet Cheer: rhythmic double-pump step bounce.
    const b = t * 6.2;
    const s = Math.sin(b);
    return person({
      x,
      z,
      y: Math.max(0, s) * 0.19,
      face: face + Math.sin(b * 0.5) * 0.12,
      pack: true,
      happy: true,
      tailPhase: b,
      legSpread: 0.15,
      legKickL: Math.max(0, -s) * 0.44,
      legKickR: Math.max(0, s) * 0.44,
      armL: { upper: [-0.36, 0.18 - s * 0.46, 0.48], fore: [-0.14, 0.62 - s * 0.36, 0.52] },
      armR: { upper: [0.36, 0.18 + s * 0.46, 0.48], fore: [0.14, 0.62 + s * 0.36, 0.52] },
    });
  }

  private renderFloatingNotes(ink: HangarInk, x: number, z: number, animTime: number, phase: number, color: string): void {
    if (this.reduceMotion) return;
    ink(color, 0.75, 1.15, () => {
      for (let i = 0; i < 2; i++) {
        const u = ((animTime * 0.75 + phase * 0.17 + i * 0.5) % 1);
        const nx = x + Math.sin(u * Math.PI * 2 + i * 2.1) * 0.32;
        const ny = 2.05 + u * 0.75;
        // Little glowing neon musical eighth-note:
        this.seg(nx - 0.06, ny, z, nx + 0.04, ny, z);
        this.seg(nx + 0.04, ny, z, nx + 0.04, ny + 0.22, z);
        this.seg(nx + 0.04, ny + 0.22, z, nx + 0.14, ny + 0.16, z);
      }
    }, false);
  }

  private renderFloatingZzz(ink: HangarInk, x: number, baseY: number, z: number, animTime: number, phase: number): void {
    ink(CYAN, 0.78, 1.15, () => {
      for (let i = 0; i < 3; i++) {
        const u = this.reduceMotion ? (i + 1) * 0.28 : ((animTime * 0.42 + phase * 0.1 + i * 0.33) % 1);
        this.label('Z', x + u * 0.38, baseY + 0.25 + u * 1.15, z, 0.22 + u * 0.16);
      }
    }, false);
  }

  private recordCadetTarget(id: PilotId, slot: number, worldX: number, worldY: number, worldZ: number): void {
    if (!this.flat(worldX, worldY + 0.95, worldZ)) return;
    const w = Math.max(44, (this.focal * 1.6) / this.sd);
    const h = Math.max(44, (this.focal * 2.1) / this.sd);
    this.cadetTargets.push({
      id,
      slot,
      x: this.sx - w / 2,
      y: this.sy - h * 0.52,
      w,
      h,
      worldX,
      worldZ,
    });
  }

  private renderCadetCallout(ink: HangarInk, x: number, z: number, text: string, color: string): void {
    ink(color, 0.95, 1.35, () => {
      this.label(text, x, 2.55, z, 0.36);
      this.seg(x - 0.14, 2.38, z, x, 2.18, z);
      this.seg(x + 0.14, 2.38, z, x, 2.18, z);
    });
  }

  /**
   * Draw all 7 non-selected pilot avatars across the hangar in a randomized scenario:
   * studying maths & typing, tossing a glowing neon ball back and forth, doing jumping jacks,
   * napping on benches, munching space pizza, zapping holo-targets, and breaking into cadet dances!
   * Also supports interactive tap/click reactions and the full-squad Dance Party (`KeyB` / `PARTY`)!
   */
  private renderSquadScenario(
    ink: HangarInk,
    animTime: number,
    mathAnswered: boolean,
    typingFinished: boolean,
  ): void {
    this.cadetTargets = [];
    const others = this.scenario.rosterOrder
      .filter((id) => id !== this.loadout.pilot)
      .map((id) => PILOT_BY_ID[id]);
    if (others.length < 7) return;

    const { catchZone, mathSecondSleeps, antics, dances, phases } = this.scenario;
    const partyOn = this.dancePartyTimer > 0;
    const partySyncMove = DANCE_MOVES[Math.floor(animTime / 2.2) % DANCE_MOVES.length]!;
    const seg = (ax: number, ay: number, az: number, bx: number, by: number, bz: number): void =>
      this.seg(ax, ay, az, bx, by, bz);

    const isReacting = (slot: number): boolean => this.cadetReaction?.slot === slot && this.cadetReaction.timer > 0;

    // 1. Typing Lab Cadet (`others[0]` at desk 15.2, 24.5):
    {
      const c = others[0]!;
      const ph = phases[0]!;
      const tap = Math.sin(animTime * 15 + ph);
      const react = isReacting(0);
      if (partyOn || react) {
        const px = 14.0;
        const pz = 23.6;
        const pose = this.reduceMotion
          ? person({ x: px, z: pz, face: Math.PI + 0.32, pack: true, happy: true })
          : this.cadetDancePose(partyOn ? partySyncMove : dances[0]!, px, pz, Math.PI + 0.32, animTime, partyOn ? 0 : ph);
        this.drawPilot(ink, c, c.colors.base, c.colors.accent, 0.9, false, pose);
        this.renderFloatingNotes(ink, px, pz, animTime, ph, c.colors.accent);
        this.recordCadetTarget(c.id, 0, px, 0, pz);
        if (react && this.cadetReaction) this.renderCadetCallout(ink, px, pz, this.cadetReaction.callout, c.colors.accent);
      } else {
        const pose = typingFinished
          ? person({
              x: 15.2,
              z: 24.5,
              scale: 0.9,
              seated: true,
              pack: true,
              happy: true,
              armL: { upper: [-0.42, 0.85, 0.22], fore: [-0.25, 0.95, 0.18] },
              armR: { upper: [0.42, 0.85, 0.22], fore: [0.25, 0.95, 0.18] },
            })
          : person({
              x: 15.2,
              z: 24.5,
              scale: 0.9,
              seated: true,
              pack: true,
              armL: { upper: [-0.15, -0.55, 0.65], fore: [0.1, -0.15 + tap * 0.18, 0.88] },
              armR: { upper: [0.15, -0.55, 0.65], fore: [-0.1, -0.15 - tap * 0.18, 0.88] },
            });
        this.drawPilot(ink, c, c.colors.base, c.colors.accent, 0.85, false, pose);
        this.recordCadetTarget(c.id, 0, 15.2, 0, 24.5);
      }
    }

    // 2. Maths Class Cadet (`others[1]` at front-right desk -14.4, 25.4):
    {
      const c = others[1]!;
      const ph = phases[1]!;
      const react = isReacting(1);
      if (partyOn || react) {
        const px = -13.1;
        const pz = 24.2;
        const pose = this.reduceMotion
          ? person({ x: px, z: pz, face: Math.PI - 0.32, pack: true, happy: true })
          : this.cadetDancePose(partyOn ? partySyncMove : dances[1]!, px, pz, Math.PI - 0.32, animTime, partyOn ? 0 : ph);
        this.drawPilot(ink, c, c.colors.base, c.colors.accent, 0.9, false, pose);
        this.renderFloatingNotes(ink, px, pz, animTime, ph, c.colors.accent);
        this.recordCadetTarget(c.id, 1, px, 0, pz);
        if (react && this.cadetReaction) this.renderCadetCallout(ink, px, pz, this.cadetReaction.callout, c.colors.accent);
      } else {
        const pose = mathAnswered
          ? person({
              x: -14.4,
              z: 25.4,
              scale: 0.9,
              seated: true,
              pack: true,
              happy: true,
              armL: { upper: [-0.38, 0.82, 0.25], fore: [-0.2, 0.92, 0.2] },
              armR: { upper: [0.38, 0.82, 0.25], fore: [0.2, 0.92, 0.2] },
            })
          : person({
              x: -14.4,
              z: 25.4,
              scale: 0.9,
              seated: true,
              pack: true,
              reach: 0.86,
            });
        this.drawPilot(ink, c, c.colors.base, c.colors.accent, 0.85, false, pose);
        this.recordCadetTarget(c.id, 1, -14.4, 0, 25.4);
      }
    }

    // Also keep two junior trainees at the back Maths Class row so the classroom stays full:
    this.people(ink, SAND, 0.42, false, [
      person({ x: -18.2, z: 28.2, scale: 0.82, seated: true, pack: true }),
      person({ x: -14.4, z: 28.2, scale: 0.82, seated: true, pack: true, reach: !mathAnswered ? 0.65 : 0 }),
    ]);

    // 3 & 4. Paired Ball-Throwing Cadets (`others[2]` & `others[3]`):
    {
      const cA = others[2]!;
      const cB = others[3]!;
      const [spotA, spotB] =
        catchZone === 'leftApron'
          ? ([[-8.6, 7.6], [-5.1, 8.3]] as const)
          : catchZone === 'rightApron'
            ? ([[5.1, 8.3], [8.6, 7.6]] as const)
            : ([[-9.1, 19.6], [-4.9, 20.4]] as const);

      this.recordCadetTarget(cA.id, 2, spotA[0], 0, spotA[1]);
      this.recordCadetTarget(cB.id, 3, spotB[0], 0, spotB[1]);

      if (partyOn) {
        for (const [c, sp, ph] of [
          [cA, spotA, phases[2]!],
          [cB, spotB, phases[3]!],
        ] as const) {
          const faceCam = sp[0] < 0 ? Math.PI - 0.25 : Math.PI + 0.25;
          const pose = this.reduceMotion
            ? person({ x: sp[0], z: sp[1], face: faceCam, pack: true, happy: true })
            : this.cadetDancePose(partySyncMove, sp[0], sp[1], faceCam, animTime, 0);
          this.drawPilot(ink, c, c.colors.base, c.colors.accent, 0.94, false, pose);
          this.renderFloatingNotes(ink, sp[0], sp[1], animTime, ph, c.colors.accent);
        }
      } else {
        const trickLob = isReacting(2) || isReacting(3);
        const faceAB = Math.atan2(spotB[0] - spotA[0], spotB[1] - spotA[1]);
        const faceBA = Math.atan2(spotA[0] - spotB[0], spotA[1] - spotB[1]);

        const cycle = (animTime + phases[2]!) / (trickLob ? 1.05 : 1.35);
        const leg = Math.floor(cycle);
        const u = cycle - leg;
        const aToB = leg % 2 === 0;
        const from = aToB ? spotA : spotB;
        const to = aToB ? spotB : spotA;

        const bx = lerp(from[0], to[0], u);
        const bz = lerp(from[1], to[1], u);
        const arcPeak = trickLob ? 3.85 : 1.55;
        const by = 1.18 + 4 * u * (1 - u) * arcPeak;

        // Glowing spinning 3D octahedron space-ball flying in an arc between them:
        ink(trickLob ? PINK : LIME, 0.95, trickLob ? 1.7 : 1.45, () => {
          const r = trickLob ? 0.26 : 0.2;
          const spin = animTime * (trickLob ? 11 : 5.5);
          const cs = Math.cos(spin) * r;
          const sn = Math.sin(spin) * r;
          const pts: readonly [number, number][] = [
            [cs, sn],
            [-sn, cs],
            [-cs, -sn],
            [sn, -cs],
          ];
          for (let i = 0; i < 4; i++) {
            const [dx0, dz0] = pts[i]!;
            const [dx1, dz1] = pts[(i + 1) % 4]!;
            seg(bx + dx0, by, bz + dz0, bx + dx1, by, bz + dz1);
            seg(bx + dx0, by, bz + dz0, bx, by + r * 1.15, bz);
            seg(bx + dx0, by, bz + dz0, bx, by - r * 1.15, bz);
          }
        });

        const throwerLift = Math.max(0, 1 - u * 2.6);
        const catcherLift = Math.max(0, (u - 0.55) / 0.45);
        const hopCatch = Math.max(0, Math.sin(catcherLift * Math.PI)) * (trickLob ? 0.48 : 0.18);

        const poseFor = (isThrower: boolean, spot: readonly [number, number], face: number, ph: number): Pose => {
          const reachAmt = isThrower ? throwerLift : catcherLift;
          return person({
            x: spot[0],
            z: spot[1],
            y: isThrower ? (trickLob ? throwerLift * 0.32 : 0) : hopCatch,
            face,
            pack: true,
            happy: trickLob || reachAmt > 0.35,
            tailPhase: animTime * 6 + ph,
            squat: isThrower ? (1 - throwerLift) * 0.04 : 0.06 * (1 - catcherLift),
            armL: {
              upper: [-0.2, -0.25 + reachAmt * 0.78, 0.55 + reachAmt * 0.3],
              fore: [0.12, 0.15 + reachAmt * 0.72, 0.75],
            },
            armR: {
              upper: [0.2, -0.25 + reachAmt * 0.88, 0.55 + reachAmt * 0.35],
              fore: [-0.12, 0.2 + reachAmt * 0.78, 0.8],
            },
          });
        };

        this.drawPilot(ink, cA, cA.colors.base, cA.colors.accent, 0.92, false, poseFor(aToB, spotA, faceAB, phases[2]!));
        this.drawPilot(ink, cB, cB.colors.base, cB.colors.accent, 0.92, false, poseFor(!aToB, spotB, faceBA, phases[3]!));
        if (trickLob && this.cadetReaction) {
          this.renderCadetCallout(ink, (spotA[0] + spotB[0]) / 2, (spotA[1] + spotB[1]) / 2, 'MEGA TOSS!', YELLOW);
        }
      }
    }

    // 5, 6 & 7. Three Randomized Hangar Antics on the open foreground/side spots:
    const openSpots: readonly [number, number, number][] =
      catchZone === 'leftApron'
        ? [
            [5.5, 7.5, Math.PI + 0.28],
            [8.6, 8.6, Math.PI + 0.42],
            [-10.4, 11.4, Math.PI - 0.38],
          ]
        : catchZone === 'rightApron'
            ? [
                [-5.5, 7.5, Math.PI - 0.28],
                [-8.6, 8.6, Math.PI - 0.42],
                [10.4, 11.4, Math.PI + 0.38],
              ]
            : [
                [-7.0, 7.7, Math.PI - 0.32],
                [5.6, 7.6, Math.PI + 0.28],
                [8.7, 8.7, Math.PI + 0.42],
              ];

    antics.forEach((act, idx) => {
      const slot = 4 + idx;
      const c = others[slot]!;
      const ph = phases[slot]!;
      const baseMove = dances[slot]!;
      const [sx, sz, faceCam] = openSpots[idx]!;
      const react = isReacting(slot);

      const spotX = act === 'mathExtra' && !partyOn && !react ? -18.2 : sx;
      const spotZ = act === 'mathExtra' && !partyOn && !react ? 25.4 : sz;
      this.recordCadetTarget(c.id, slot, spotX, 0, spotZ);

      // Spontaneous ~4.2s cadet dance break every ~13.5s, OR tapped cadet reaction, OR full-squad Dance Party!
      const danceWindow = !this.reduceMotion && ((animTime + ph * 1.3) % 13.5) < 4.2;
      const activeMove = partyOn
        ? partySyncMove
        : DANCE_MOVES[(DANCE_MOVES.indexOf(baseMove) + Math.floor((animTime + ph) / 6.5)) % DANCE_MOVES.length]!;

      if (partyOn || react || act === 'dance' || (danceWindow && (act === 'jacks' || act === 'practice'))) {
        if (act === 'sleep') {
          // Keep the empty nap bench drawn behind the woken-up dancing cadet!
          ink(BLUE, 0.5, 1.1, () => {
            this.box(sx, 0.36, sz + 0.65, 2.2, 0.1, 0.85);
          }, false);
        }
        const pose = this.reduceMotion
          ? person({ x: sx, z: sz, face: faceCam, pack: true, happy: true })
          : this.cadetDancePose(activeMove, sx, sz, faceCam, animTime, partyOn ? 0 : ph);
        this.drawPilot(ink, c, c.colors.base, c.colors.accent, 0.94, false, pose);
        this.renderFloatingNotes(ink, sx, sz, animTime, ph, c.colors.accent);
        if (react && this.cadetReaction) {
          const msg = act === 'sleep' ? 'IM AWAKE!' : this.cadetReaction.callout;
          this.renderCadetCallout(ink, sx, sz, msg, c.colors.accent);
        }
        return;
      }

      if (act === 'jacks') {
        const b = animTime * 5.2 + ph;
        const u = this.reduceMotion ? 0.75 : 0.5 - 0.5 * Math.cos(b);
        const hop = this.reduceMotion ? 0 : Math.max(0, Math.sin(b - 0.3)) * 0.3;
        const pose = person({
          x: sx,
          z: sz,
          y: hop,
          face: faceCam,
          pack: true,
          happy: u > 0.55,
          tailPhase: b,
          legSpread: u * 0.46,
          armL: {
            upper: [lerp(-0.18, -0.58, Math.sin(u * Math.PI * 0.68)), lerp(-1, 0.88, u), 0.06],
            fore: [lerp(-0.08, 0.32, u), lerp(-1, 0.95, u), 0.08],
          },
          armR: {
            upper: [lerp(0.18, 0.58, Math.sin(u * Math.PI * 0.68)), lerp(-1, 0.88, u), 0.06],
            fore: [lerp(0.08, -0.32, u), lerp(-1, 0.95, u), 0.08],
          },
        });
        this.drawPilot(ink, c, c.colors.base, c.colors.accent, 0.94, false, pose);
        return;
      }

      if (act === 'sleep') {
        // Low-poly hangar nap bench + pillow + stretched-out snoozing cadet + rising Zzzs!
        const benchFace = sx < 0 ? Math.PI * 0.42 : -Math.PI * 0.42;
        ink(BLUE, 0.55, 1.1, () => {
          this.box(sx, 0.36, sz, 2.2, 0.1, 0.85);
          seg(sx - 0.95, 0, sz - 0.3, sx - 0.95, 0.36, sz - 0.3);
          seg(sx + 0.95, 0, sz - 0.3, sx + 0.95, 0.36, sz - 0.3);
          seg(sx - 0.95, 0, sz + 0.3, sx - 0.95, 0.36, sz + 0.3);
          seg(sx + 0.95, 0, sz + 0.3, sx + 0.95, 0.36, sz + 0.3);
        }, false);
        const pose = person({
          x: sx,
          z: sz,
          face: benchFace,
          lying: true,
          sleeping: true,
          pack: false,
          armL: { upper: [-0.22, -0.62, 0.26], fore: [0.45, -0.22, 0.42] },
          armR: { upper: [0.22, -0.62, 0.26], fore: [-0.45, -0.22, 0.42] },
        });
        this.drawPilot(ink, c, c.colors.base, c.colors.accent, 0.9, false, pose);
        this.renderFloatingZzz(ink, sx + Math.sin(benchFace) * 0.72, 0.82, sz + Math.cos(benchFace) * 0.72, animTime, ph);
        return;
      }

      if (act === 'eat') {
        // Supply crate seat + open space-pizza box + cadet munching a glowing neon pizza slice!
        ink(ORANGE, 0.62, 1.1, () => {
          this.box(sx, 0, sz - 0.08, 0.92, 0.54, 0.85);
          this.box(sx + (sx < 0 ? 0.88 : -0.88), 0, sz + 0.12, 0.68, 0.42, 0.68);
        }, false);
        const chomp = this.reduceMotion ? 0.65 : 0.5 + 0.5 * Math.sin(animTime * 4.1 + ph);
        const pose = person({
          x: sx,
          z: sz,
          face: faceCam,
          seated: true,
          pack: true,
          happy: chomp > 0.6,
          armL: { upper: [-0.25, -0.6, 0.45], fore: [0.15, -0.25, 0.6] },
          armR: {
            upper: [0.22, -0.35 + chomp * 0.52, 0.62],
            fore: [-0.36, 0.22 + chomp * 0.66, 0.42],
          },
        });
        this.drawPilot(ink, c, c.colors.base, c.colors.accent, 0.92, false, pose);
        // Glowing neon pizza slice near hand/mouth:
        const sliceY = 1.02 + chomp * 0.22;
        const sliceX = sx + Math.sin(faceCam) * 0.34;
        const sliceZ = sz + Math.cos(faceCam) * 0.34;
        ink(YELLOW, 0.95, 1.35, () => {
          seg(sliceX - 0.11, sliceY + 0.06, sliceZ, sliceX + 0.11, sliceY + 0.06, sliceZ);
          seg(sliceX - 0.11, sliceY + 0.06, sliceZ, sliceX, sliceY - 0.12, sliceZ + 0.05);
          seg(sliceX + 0.11, sliceY + 0.06, sliceZ, sliceX, sliceY - 0.12, sliceZ + 0.05);
        }, false);
        return;
      }

      if (act === 'practice') {
        // Strafing blaster practice against a spinning 3D holo-bullseye target!
        const dir = sx < 0 ? -1 : 1;
        const tx = sx + dir * 2.15;
        const tz = sz + 0.55;
        const ty = 1.28 + (this.reduceMotion ? 0 : Math.sin(animTime * 2.8 + ph) * 0.16);
        const strafe = this.reduceMotion ? 0 : Math.sin(animTime * 2.6 + ph) * 0.32;
        const px = sx - dir * 0.25;
        const pz = sz + strafe;
        const aimFace = Math.atan2(tx - px, tz - pz);

        ink(PINK, 0.85, 1.3, () => {
          seg(tx, 0, tz, tx, ty - 0.38, tz);
          for (const r of [0.36, 0.18]) {
            seg(tx, ty + r, tz, tx, ty, tz + r);
            seg(tx, ty, tz + r, tx, ty - r, tz);
            seg(tx, ty - r, tz, tx, ty, tz - r);
            seg(tx, ty, tz - r, tx, ty + r, tz);
          }
        }, false);

        if (!this.reduceMotion) {
          const shotU = ((animTime * 2.4 + ph) % 1);
          const bx0 = lerp(px + dir * 0.45, tx, shotU);
          const bz0 = lerp(pz, tz, shotU);
          const bx1 = lerp(px + dir * 0.45, tx, Math.min(1, shotU + 0.18));
          const bz1 = lerp(pz, tz, Math.min(1, shotU + 0.18));
          ink(SAND, 0.95, 1.5, () => seg(bx0, 1.28, bz0, bx1, ty, bz1));
        }

        const pose = person({
          x: px,
          z: pz,
          face: aimFace,
          pack: true,
          squat: 0.08,
          legSpread: 0.18,
          tailPhase: animTime * 6 + ph,
          armL: { upper: [-0.35, -0.35, 0.45], fore: [0.2, -0.1, 0.55] },
          armR: { upper: [0.1, 0.08, 0.95], fore: [0, 0.04, 1] },
          tool: 0.24,
        });
        this.drawPilot(ink, c, c.colors.base, c.colors.accent, 0.92, false, pose);
        return;
      }

      // 'mathExtra': Extra named cadet at front-left Maths Class desk (-18.2, 25.4) — studying or snoozing!
      const deskPose = mathSecondSleeps
        ? person({
            x: -18.2,
            z: 25.4,
            scale: 0.9,
            seated: true,
            sleeping: true,
            pack: true,
            armL: { upper: [-0.2, -0.45, 0.65], fore: [0.25, -0.1, 0.65] },
            armR: { upper: [0.2, -0.45, 0.65], fore: [-0.25, -0.1, 0.65] },
          })
        : person({
            x: -18.2,
            z: 25.4,
            scale: 0.9,
            seated: true,
            pack: true,
            happy: mathAnswered,
            reach: !mathAnswered ? 0.72 : 0,
          });
      this.drawPilot(ink, c, c.colors.base, c.colors.accent, 0.85, false, deskPose);
      if (mathSecondSleeps) {
        this.renderFloatingZzz(ink, -18.2, 1.35, 25.4, animTime, ph);
      }
    });
  }

  // ----------------------------------------------------------------- 3D ships

  /**
   * Draw one of the three ship archetypes in 3D, parked on its landing gear.
   * Seen from above, each 3D hull matches its top-down 2D silhouette in `shapes.ts`!
   */
  private craft(kind: ShipId, x: number, z: number, face: number, open: number): void {
    const cos = Math.cos(face);
    const sin = Math.sin(face);
    const L = (ax: number, ay: number, az: number, bx: number, by: number, bz: number): void =>
      this.seg(x + ax * cos + az * sin, ay, z - ax * sin + az * cos, x + bx * cos + bz * sin, by, z - bx * sin + bz * cos);
    const deck = 1;

    if (kind === 'swift') {
      // Fast Interceptor: needle nose (z=+4.7), forward-swept gull wings, twin nose blasters, single afterburner.
      const hull = [
        [0, 4.7], [0.65, 1.75], [2.85, 2.55], [3.2, -0.5], [1.1, -1.5],
        [0.6, -3.1], [-0.6, -3.1], [-1.1, -1.5], [-3.2, -0.5], [-2.85, 2.55], [-0.65, 1.75],
      ] as const;
      hull.forEach(([hx, hz], i) => {
        const [nx, nz] = hull[(i + 1) % hull.length]!;
        L(hx, deck, hz, nx, deck, nz);
      });
      const spine = [[0, deck, 4.7], [0, 1.48, 2.1], [0, 1.56, -0.8], [0, 2.22, -2.8], [0, deck + 0.1, -3.1]] as const;
      for (let i = 0; i < spine.length - 1; i++) {
        const [ax, ay, az] = spine[i]!;
        const [bx, by, bz] = spine[i + 1]!;
        L(ax, ay, az, bx, by, bz);
      }
      for (const side of [-1, 1]) {
        L(0, 1.48, 2.1, side * 0.65, deck, 1.75);
        L(side * 0.65, deck, 1.75, side * 2.85, deck + 0.25, 2.55);
        L(0, 1.56, -0.8, side * 3.2, deck, -0.5);
        L(0, 1.56, -0.8, side * 1.1, deck, -1.5);
        L(0, 2.22, -2.8, side * 0.6, deck, -3.1);
        // Twin nose blaster barrels.
        L(side * 0.65, deck + 0.05, 1.75, side * 0.65, deck + 0.05, 3.1);
        // Main landing struts.
        L(side * 1.5, deck, -1.2, side * 1.5, 0, -1.2);
        L(side * 1.5 - 0.26, 0, -1.2, side * 1.5 + 0.26, 0, -1.2);
      }
      // Nose strut + single central afterburner nozzle.
      L(0, deck, 3.1, 0, 0, 3.1);
      L(-0.26, 0, 3.1, 0.26, 0, 3.1);
      L(-0.38, deck - 0.22, -3.1, 0.38, deck - 0.22, -3.1);
      L(-0.38, deck + 0.24, -3.1, 0.38, deck + 0.24, -3.1);
    } else if (kind === 'bastion') {
      // Heavy Armoured Gunship: twin-prong nose, broad wingtip cannon pods, twin dorsal spines, wide twin nacelles.
      const hull = [
        [-1.1, 3.5], [-0.45, 2.75], [0.45, 2.75], [1.1, 3.5], [1.6, 1.5], [3.6, 0.5], [3.6, -2.1],
        [2.25, -2.6], [1.85, -3.25], [0.8, -3.25], [0.55, -2.35], [-0.55, -2.35],
        [-0.8, -3.25], [-1.85, -3.25], [-2.25, -2.6], [-3.6, -2.1], [-3.6, 0.5], [-1.6, 1.5],
      ] as const;
      hull.forEach(([hx, hz], i) => {
        const [nx, nz] = hull[(i + 1) % hull.length]!;
        L(hx, deck, hz, nx, deck, nz);
      });
      for (const side of [-1, 1]) {
        // Twin armoured spines & heavy wingtip cannons.
        L(side * 1.1, deck, 3.5, side * 0.9, 1.62, 1.5);
        L(side * 0.9, 1.62, 1.5, side * 1.15, 1.72, -1.2);
        L(side * 1.15, 1.72, -1.2, side * 1.32, 2.35, -3.0);
        L(side * 1.32, 2.35, -3.0, side * 1.85, deck, -3.25);
        L(side * 1.15, 1.72, -1.2, side * 3.6, deck, -2.1);
        L(side * 0.9, 1.62, 1.5, side * 3.6, deck, 0.5);
        // Heavy wingtip cannon barrel.
        L(side * 3.0, deck + 0.08, 0.5, side * 3.0, deck + 0.08, 2.15);
        // Four sturdy landing legs + twin wide engine nacelles.
        L(side * 2.1, deck, -1.8, side * 2.1, 0, -1.8);
        L(side * 2.1 - 0.32, 0, -1.8, side * 2.1 + 0.32, 0, -1.8);
        L(side * 1.0, deck, 2.2, side * 1.0, 0, 2.2);
        L(side * 1.0 - 0.25, 0, 2.2, side * 1.0 + 0.25, 0, 2.2);
        L(side * 1.32 - 0.38, deck - 0.25, -3.25, side * 1.32 + 0.38, deck - 0.25, -3.25);
        L(side * 1.32 - 0.38, deck + 0.24, -3.25, side * 1.32 + 0.38, deck + 0.24, -3.25);
      }
      L(-0.9, 1.62, 1.5, 0.9, 1.62, 1.5);
      L(-1.15, 1.72, -1.2, 1.15, 1.72, -1.2);
    } else {
      // Starhawk (Classic balanced school fighter).
      const hull = [[0, 4], [1, 1], [3.25, -2.5], [1.25, -1.75], [0.75, -3], [-0.75, -3], [-1.25, -1.75], [-3.25, -2.5], [-1, 1]] as const;
      hull.forEach(([hx, hz], i) => {
        const [nx, nz] = hull[(i + 1) % hull.length]!;
        L(hx, deck, hz, nx, deck, nz);
      });
      const spine = [[0, deck, 4], [0, 1.5, 1.6], [0, 1.6, -0.9], [0, 2.3, -2.9], [0, deck + 0.1, -3]] as const;
      for (let i = 0; i < spine.length - 1; i++) {
        const [ax, ay, az] = spine[i]!;
        const [bx, by, bz] = spine[i + 1]!;
        L(ax, ay, az, bx, by, bz);
      }
      for (const side of [-1, 1]) {
        L(0, 1.5, 1.6, side, deck, 1);
        L(0, 1.6, -0.9, side * 1.25, deck, -1.75);
        L(0, 1.6, -0.9, side * 3.25, deck, -2.5);
        L(0, 2.3, -2.9, side * 0.75, deck, -3);
        L(side * 1.7, deck, -1.9, side * 1.7, 0, -1.9);
        L(side * 1.7 - 0.3, 0, -1.9, side * 1.7 + 0.3, 0, -1.9);
        L(side * 0.5 - 0.22, deck - 0.25, -3, side * 0.5 + 0.22, deck - 0.25, -3);
        L(side * 0.5 - 0.22, deck + 0.2, -3, side * 0.5 + 0.22, deck + 0.2, -3);
      }
      L(0, deck, 2.7, 0, 0, 2.7);
      L(-0.3, 0, 2.7, 0.3, 0, 2.7);
    }

    // Hinged canopy: opens upwards from the rear hinge on all three ships.
    const lift = open * 0.95;
    const canopyWide = kind === 'bastion' ? 0.86 : kind === 'swift' ? 0.5 : 0.62;
    const hinge = [0, 1.64, -0.75] as const;
    const tip = (py: number, pz: number): [number, number] => {
      const dy = py - hinge[1];
      const dz = pz - hinge[2];
      return [hinge[1] + dy * Math.cos(lift) + dz * Math.sin(lift), hinge[2] - dy * Math.sin(lift) + dz * Math.cos(lift)];
    };
    const [fy, fz] = tip(1.52, kind === 'swift' ? 1.8 : 1.5);
    const [ty, tz] = tip(2.14, 0.35);
    L(0, hinge[1], hinge[2], 0, ty, tz);
    L(0, ty, tz, 0, fy, fz);
    for (const side of [-1, 1]) {
      const [sy, sz] = tip(1.5, 0.3);
      L(side * canopyWide, sy, sz, 0, ty, tz);
      L(side * canopyWide, sy, sz, 0, fy, fz);
      L(side * canopyWide, sy, sz, 0, hinge[1], hinge[2]);
    }
  }

  private drawLadder(ship: (typeof SHIPS)[number], shipZ: number): void {
    const side = ship.bay.ladderSide;
    const lx = ship.bay.x + side * (ship.id === 'bastion' ? 2.05 : 1.72);
    const lz = shipZ + 0.45;
    const footX = lx + side * 0.72;
    const topX = lx - side * 0.42;
    for (const dz of [-0.28, 0.28]) {
      this.seg(footX, 0, lz + dz, topX, 1.25, lz + dz);
    }
    for (let i = 1; i <= 4; i++) {
      const u = i / 5;
      const rx = lerp(footX, topX, u);
      this.seg(rx, 1.25 * u, lz - 0.28, rx, 1.25 * u, lz + 0.28);
    }
  }

  // ----------------------------------------------------------------- scene & UI

  render(f: HangarFrame): void {
    const { ctx, ink, w, h, time } = f;
    this.w = w;
    this.h = h;
    this.reduceMotion = f.reduceMotion ?? this.reduceMotion;
    this.lastInset = f.inset ?? { top: 0, right: 0, bottom: 0, left: 0 };
    this.ctx = ctx;
    this.ensureGeometry();

    const seg = (ax: number, ay: number, az: number, bx: number, by: number, bz: number): void =>
      this.seg(ax, ay, az, bx, by, bz);
    const theme = THEME_BY_ID[this.loadout.theme];
    const pilotSpec = PILOT_BY_ID[this.loadout.pilot];
    const selectedShip = SHIP_BY_ID[this.loadout.ship];
    const animTime = this.reduceMotion ? 0 : time;

    // --- outside the door: a low-poly ringed planet + Flight School traffic passing across deep space
    ctx.save();
    ctx.beginPath();
    this.clipSky(ctx);
    ctx.clip();
    ink(MINT, 0.55, 1.1, () => {
      const [px, py, pz, r] = [9, 15, DEPTH + 150, 11];
      const spin = animTime * 0.045;
      const at = (turn: number, scale: number): [number, number] => [
        px + Math.cos(turn * Math.PI * 2 + 0.3 + spin) * r * scale,
        py + Math.sin(turn * Math.PI * 2 + 0.3 + spin) * r * scale,
      ];
      for (let i = 0; i < 10; i++) {
        const [x0, y0] = at(i / 10, 1);
        const [x1, y1] = at((i + 1) / 10, 1);
        seg(x0, y0, pz, x1, y1, pz);
      }
      for (let i = 0; i < 5; i++) {
        const [ix, iy] = at((i * 2 + 1) / 10, 0.52);
        const [jx, jy] = at((i * 2 + 3) / 10, 0.52);
        seg(ix, iy, pz, jx, jy, pz);
        seg(ix, iy, pz, px - 1, py + 1, pz);
        for (const k of [0, 1, 2]) {
          const [rx, ry] = at((i * 2 + k) / 10, 1);
          seg(ix, iy, pz, rx, ry, pz);
        }
      }
      for (let i = 0; i < 24; i++) {
        const a = (i * Math.PI) / 12, b = ((i + 1) * Math.PI) / 12;
        if (Math.sin(a + 0.13) > 0.1 && Math.abs(Math.cos(a + 0.13)) < 0.62) continue;
        seg(px + Math.cos(a) * r * 1.75, py + Math.sin(a) * r * 0.4, pz, px + Math.cos(b) * r * 1.75, py + Math.sin(b) * r * 0.4, pz);
      }
    }, false);
    if (!this.reduceMotion) {
      this.renderDoorwaySpaceTraffic(ctx, ink, animTime);
    }
    ctx.restore();

    // --- the building: floor, walls, roof, and the door open to space
    ink(BLUE, 0.2, 1, () => {
      for (let z = 0; z <= DEPTH; z += 6) seg(-HALF, 0, z, HALF, 0, z);
      for (let x = -HALF; x <= HALF; x += 6) seg(x, 0, 0, x, 0, DEPTH);
    }, false);
    const partyOn = this.dancePartyTimer > 0;
    if (partyOn) {
      const partyPalette = [PINK, CYAN, YELLOW, LIME, VIOLET] as const;
      const beat = Math.floor(animTime * 6.5);
      ARCHES.forEach((z, idx) => {
        const archCol = partyPalette[(idx + beat) % partyPalette.length]!;
        ink(archCol, 0.78, 1.4, () => {
          seg(-HALF, 0, z, -HALF, WALL, z);
          seg(-HALF, WALL, z, -15, ROOF, z);
          seg(-15, ROOF, z, 15, ROOF, z);
          seg(15, ROOF, z, HALF, WALL, z);
          seg(HALF, WALL, z, HALF, 0, z);
        });
      });
      ink(CYAN, 0.52, 1.15, () => {
        for (const [x, y] of [[-HALF, WALL], [-15, ROOF], [15, ROOF], [HALF, WALL]] as const) seg(x, y, ARCHES[0]!, x, y, DEPTH);
        seg(-HALF, 0, DEPTH, -DOOR_HALF, 0, DEPTH);
        seg(DOOR_HALF, 0, DEPTH, HALF, 0, DEPTH);
      }, false);
      this.renderDiscoBall(ink, animTime);
    } else {
      ink(VIOLET, 0.4, 1.1, () => {
        for (const z of ARCHES) {
          seg(-HALF, 0, z, -HALF, WALL, z);
          seg(-HALF, WALL, z, -15, ROOF, z);
          seg(-15, ROOF, z, 15, ROOF, z);
          seg(15, ROOF, z, HALF, WALL, z);
          seg(HALF, WALL, z, HALF, 0, z);
        }
        for (const [x, y] of [[-HALF, WALL], [-15, ROOF], [15, ROOF], [HALF, WALL]] as const) seg(x, y, ARCHES[0]!, x, y, DEPTH);
        seg(-HALF, 0, DEPTH, -DOOR_HALF, 0, DEPTH);
        seg(DOOR_HALF, 0, DEPTH, HALF, 0, DEPTH);
      }, false);
    }
    ink(CYAN, 0.9, 1.6, () => {
      seg(-DOOR_HALF, 0, DEPTH, -DOOR_HALF, DOOR_TOP, DEPTH);
      seg(-DOOR_HALF, DOOR_TOP, DEPTH, DOOR_HALF, DOOR_TOP, DEPTH);
      seg(DOOR_HALF, DOOR_TOP, DEPTH, DOOR_HALF, 0, DEPTH);
    });
    ink(CYAN, 0.1 + 0.04 * Math.sin(animTime * 3), 1, () => {
      for (let x = -DOOR_HALF + 1.1; x < DOOR_HALF; x += 1.1) seg(x, 0, DEPTH, x, DOOR_TOP, DEPTH);
    }, false);

    // Painted launch-bay floor pads and taxi guide lines converging gently into the space door:
    SHIPS.forEach((ship, i) => {
      const active = ship.id === this.loadout.ship;
      ink(active ? theme.hull : YELLOW, active ? 0.65 : 0.28, active ? 1.3 : 1, () => {
        const bx = ship.bay.x;
        const bz = ship.bay.z;
        seg(bx - 3.8, 0, bz - 4, bx + 3.8, 0, bz - 4);
        seg(bx - 3.8, 0, bz - 4, bx - 3.8, 0, bz + 4.8);
        seg(bx + 3.8, 0, bz - 4, bx + 3.8, 0, bz + 4.8);
        this.label(`BAY ${i + 1}`, bx, 0.08, bz - 4.7, 0.45);
        for (let z = bz + 5.5; z < DEPTH - 1; z += 4) {
          const u0 = (z - bz) / (DEPTH - bz);
          const u1 = Math.min(1, (z + 2 - bz) / (DEPTH - bz));
          seg(lerp(bx, bx * 0.45, u0), 0, z, lerp(bx, bx * 0.45, u1), 0, z + 2);
        }
      }, false);
    });

    // --- the school: its name over the door, the alphabet and numbers along the wall, clock, bunting
    ink(SAND, 0.9, 1.4, () => this.label('SPACE PILOT SCHOOL', 0, DOOR_TOP + 4.6, DEPTH, 2));
    ink(PINK, 0.55, 1, () => {
      this.label('A B C D E F G H I J K L M N O P Q R S T U V W X Y Z', 0, DOOR_TOP + 1.6, DEPTH, 0.62);
      this.label('1 2 3 4 5 6 7 8 9 10', 17.5, 3.6, DEPTH, 0.6);
      this.label('HANGAR 3', 17.5, 5.6, DEPTH, 0.9);
    }, false);
    ink(SAND, 0.55, 1, () => {
      const [kx, ky] = [17.5, 9];
      for (let i = 0; i < 8; i++) {
        const a = (i * Math.PI) / 4, b = ((i + 1) * Math.PI) / 4;
        seg(kx + Math.cos(a) * 1.3, ky + Math.sin(a) * 1.3, DEPTH, kx + Math.cos(b) * 1.3, ky + Math.sin(b) * 1.3, DEPTH);
      }
      seg(kx, ky, DEPTH, kx + Math.sin(animTime * 0.7) * 1, ky + Math.cos(animTime * 0.7) * 1, DEPTH);
      seg(kx, ky, DEPTH, kx + 0.55, ky + 0.4, DEPTH);
      for (let z = 3; z < 14.9; z += 1.2) {
        seg(-HALF, 0, z, -HALF, 2.3, z);
        seg(-HALF, 2.3, z, -HALF, 2.3, z + 1.2);
        seg(-HALF, 1.7, z + 0.3, -HALF, 1.7, z + 0.9);
      }
      seg(-HALF, 0, 15, -HALF, 2.3, 15);
    }, false);
    for (const [color, odd] of [[YELLOW, 0], [PINK, 1]] as const) {
      ink(color, 0.5, 1, () => {
        const flags = 16;
        for (let i = 0; i < flags; i++) {
          const at = (k: number): [number, number] => {
            const u = k / flags;
            return [lerp(-HALF, HALF, u), 15.5 - Math.sin(u * Math.PI) * 2.2];
          };
          const [x0, y0] = at(i);
          const [x1, y1] = at(i + 1);
          if (!odd) seg(x0, y0, 22, x1, y1, 22);
          if (i % 2 === odd) {
            seg(x0, y0, 22, (x0 + x1) / 2, (y0 + y1) / 2 - 1.1, 22);
            seg((x0 + x1) / 2, (y0 + y1) / 2 - 1.1, 22, x1, y1, 22);
          }
        }
      }, false);
    }

    // --- the maths lesson: a board on legs, a teacher with a pointer, pilots at their desks
    const board = { x: -15.5, z: 32, y: 1.4, wide: 8.6, tall: 4.2 };
    const sum = this.sums[Math.floor(animTime / 4.5) % this.sums.length]!;
    const answered = animTime % 4.5 > 2.4;
    ink(CYAN, 0.68, 1.2, () => {
      this.box(board.x, board.y, board.z, board.wide, board.tall, 0.2);
      seg(board.x - 3.4, 0, board.z, board.x - 3.4, board.y, board.z);
      seg(board.x + 3.4, 0, board.z, board.x + 3.4, board.y, board.z);
      this.label('MATHS CLASS', board.x, board.y + board.tall + 1.2, board.z, 0.6);
    }, false);
    const asked = `${sum.question} = ${answered ? '' : '?'}`;
    ink(SAND, 0.85, 1.3, () => this.label(answered ? `${asked}${' '.repeat(String(sum.answer).length)}` : asked, board.x, board.y + board.tall - 1.5, board.z - 0.12, 0.8));
    if (answered) {
      ink(LIME, 1, 1.4, () => this.label(`${' '.repeat(asked.length)}${sum.answer}`, board.x, board.y + board.tall - 1.5, board.z - 0.12, 0.8));
    }
    const desks = [[-18.2, 25.4], [-14.4, 25.4], [-18.2, 28.2], [-14.4, 28.2]] as const;
    ink(BLUE, 0.5, 1, () => {
      for (const [x, z] of desks) {
        this.box(x, 0.62, z + 0.55, 1.5, 0.06, 0.7);
        seg(x - 0.7, 0, z + 0.55, x - 0.7, 0.62, z + 0.55);
        seg(x + 0.7, 0, z + 0.55, x + 0.7, 0.62, z + 0.55);
      }
    }, false);
    const teacher = person({ x: -20.8, z: 30.8, face: 1.75, hat: 'cap', reach: 0.52 + Math.sin(animTime * 1.6) * 0.04, tool: 0.75 });
    this.people(ink, CYAN, 0.72, false, [teacher]);

    // --- the typing lab (pushed slightly back-right so Bay 3 sits unobstructed in the foreground!)
    const desk = { x: 15.2, z: 24.5 };
    const word = this.words[Math.floor(animTime / 5) % this.words.length]!;
    const typed = Math.min(word.length, Math.floor((animTime % 5) / 0.45));
    ink(CYAN, 0.6, 1.1, () => {
      this.box(desk.x, 0, desk.z + 1.3, 3, 0.75, 0.9);
      this.box(desk.x, 1.3, desk.z + 1.55, 3, 1.5, 0.1);
      seg(desk.x, 0.75, desk.z + 1.55, desk.x, 1.3, desk.z + 1.55);
      this.label('TYPING LAB', desk.x, 3.9, desk.z + 1.55, 0.5);
    }, false);
    ink(SAND, 0.35, 1.2, () => this.label(' '.repeat(typed) + word.slice(typed), desk.x, 2.4, desk.z + 1.45, 0.58), false);
    if (typed) ink(LIME, 0.95, 1.3, () => this.label(word.slice(0, typed) + ' '.repeat(word.length - typed), desk.x, 2.4, desk.z + 1.45, 0.58));

    // --- the 7 other named pilot avatars scattered across the hangar in a randomized scenario!
    this.renderSquadScenario(ink, animTime, answered, typed >= word.length);

    // --- far background ships, mechanics, sparks, crate robot and scanning drone
    ink(VIOLET, 0.42, 1.1, () => {
      this.craft('starhawk', 15.5, 39, -0.2, 0);
      this.craft('bastion', -4.5, 40, 0.3, 0);
    }, false);
    const welder = person({ x: 12.6, z: 38.2, face: 1.35, hat: 'none', reach: 0.42, tool: 0.3 });
    const fitter = person({ x: -1.4, z: 39.6, y: 0.9, face: -1.5, hat: 'cap', reach: 0.62 + Math.sin(animTime * 5) * 0.05, tool: 0.35 });
    this.people(ink, ORANGE, 0.72, false, [welder, fitter]);
    ink(ORANGE, 0.5, 1, () => this.box(fitter.x, 0, fitter.z, 0.9, 0.9, 0.9), false);
    if (!this.reduceMotion) {
      const spark = { x: 13.45, y: 1.32, z: 38.4 };
      const flare = 0.55 + 0.45 * Math.abs(Math.sin(animTime * 23));
      ink(YELLOW, flare, 1.5, () => {
        for (let i = 0; i < 6; i++) {
          const a = (i * Math.PI) / 3 + animTime * 4;
          seg(spark.x, spark.y, spark.z, spark.x + Math.cos(a) * 0.3 * flare, spark.y + Math.sin(a) * 0.3 * flare, spark.z);
        }
        for (let i = 0; i < 5; i++) {
          const age = (animTime * 1.4 + i * 0.37) % 1;
          const sx = spark.x + (i - 2) * 0.22 * age * 2.2;
          const sy = spark.y + 0.5 * age - 2.2 * age * age;
          seg(sx, sy, spark.z, sx + (i - 2) * 0.03, sy - 0.12, spark.z);
        }
      });
    }
    const lap = (animTime * 0.09) % 1;
    const away = lap < 0.5;
    const robot = { x: -10.8, z: lerp(22, 36, away ? lap * 2 : 2 - lap * 2), dir: away ? 1 : -1 };
    ink(LIME, 0.68, 1.2, () => {
      this.box(robot.x, 0.28, robot.z, 0.75, 0.95, 0.95);
      this.box(robot.x, 1.3, robot.z, 0.5, 0.45, 0.55);
      seg(robot.x, 1.75, robot.z, robot.x, 2.15, robot.z);
      seg(robot.x - 0.12, 2.15, robot.z, robot.x + 0.12, 2.15, robot.z);
      for (const side of [-1, 1]) this.box(robot.x + side * 0.48, 0, robot.z, 0.1, 0.36, 0.5);
      seg(robot.x - 0.14, 1.52, robot.z + robot.dir * 0.28, robot.x + 0.14, 1.52, robot.z + robot.dir * 0.28);
      for (const side of [-1, 1]) seg(robot.x + side * 0.3, 0.95, robot.z + robot.dir * 0.48, robot.x + side * 0.3, 0.8, robot.z + robot.dir * 0.95);
      this.box(robot.x, 0.55, robot.z + robot.dir * 1.25, 0.62, 0.62, 0.62);
    }, false);
    const drone = { x: 15.5 + Math.sin(animTime * 0.6) * 1.6, y: 4.3 + Math.sin(animTime * 1.7) * 0.25, z: 39 + Math.cos(animTime * 0.6) * 1.2 };
    ink(LIME, 0.68, 1.1, () => {
      for (const [dx, dz] of [[0.45, 0], [0, 0.45], [-0.45, 0], [0, -0.45]] as const) {
        seg(drone.x + dx, drone.y, drone.z + dz, drone.x, drone.y + 0.32, drone.z);
        seg(drone.x + dx, drone.y, drone.z + dz, drone.x, drone.y - 0.32, drone.z);
        seg(drone.x + dx, drone.y, drone.z + dz, drone.x - dz, drone.y, drone.z + dx);
      }
    }, false);
    ink(LIME, 0.28, 1, () => seg(drone.x, drone.y - 0.32, drone.z, 15.5 + Math.sin(animTime * 2.1) * 1.2, 1.4, 39 + Math.cos(animTime * 1.3) * 2.4), false);

    // --- the three selectable player ships parked in Bays 1, 2 and 3!
    const boarding = this.stage === 'boarding';
    const bt = boarding ? this.t : 0;
    const rolling = boarding ? smooth((bt - SHUT) / (END - SHUT)) : 0;

    for (const ship of SHIPS) {
      const isChosen = ship.id === this.loadout.ship;
      const zNow = isChosen && boarding ? ship.bay.z + rolling * rolling * 18 : ship.bay.z;
      const xNow = isChosen && boarding ? lerp(ship.bay.x, ship.bay.x * 0.5, rolling) : ship.bay.x;
      const faceNow = isChosen && boarding ? lerp(ship.bay.face, 0, smooth((bt - SEATED) / (END - SEATED))) : ship.bay.face;
      const openNow = isChosen && boarding ? 1 - smooth((bt - SEATED - 0.15) / (SHUT - SEATED - 0.15)) : 1;

      if (isChosen) {
        ink(theme.hull, 1, 1.7, () => this.craft(ship.id, xNow, zNow, faceNow, openNow), true);
        if (!boarding || bt < SHUT) {
          const fadeLadder = boarding ? 1 - smooth((bt - SEATED) / (SHUT - SEATED)) : 0.85;
          ink(theme.accent, 0.82 * fadeLadder, 1.2, () => this.drawLadder(ship, zNow), false);
        }
        if (boarding && bt > SHUT - 0.1) {
          ink(theme.thruster, 0.95, 1.6, () => {
            const flame = 0.75 + rolling * 1.7 + (this.reduceMotion ? 0.15 : Math.abs(Math.sin(animTime * 31)) * 0.32);
            if (ship.id === 'swift') {
              seg(xNow - 0.24, 1, zNow - 3.1, xNow, 1, zNow - 3.1 - flame * 1.25);
              seg(xNow + 0.24, 1, zNow - 3.1, xNow, 1, zNow - 3.1 - flame * 1.25);
            } else if (ship.id === 'bastion') {
              for (const side of [-1, 1]) {
                seg(xNow + side * 1.32 - 0.28, 1, zNow - 3.25, xNow + side * 1.32, 1, zNow - 3.25 - flame);
                seg(xNow + side * 1.32 + 0.28, 1, zNow - 3.25, xNow + side * 1.32, 1, zNow - 3.25 - flame);
              }
            } else {
              for (const side of [-1, 1]) {
                seg(xNow + side * 0.5 - 0.2, 1, zNow - 3, xNow + side * 0.5, 1, zNow - 3 - flame);
                seg(xNow + side * 0.5 + 0.2, 1, zNow - 3, xNow + side * 0.5, 1, zNow - 3 - flame);
              }
            }
          });
        }
      } else {
        const alpha = this.stage === 'ship' ? 0.62 : 0.45;
        ink(CYAN, alpha, 1.2, () => this.craft(ship.id, ship.bay.x, ship.bay.z, ship.bay.face, this.stage === 'ship' ? 0.95 : 0.25), false);
        if (this.stage === 'ship') {
          ink(CYAN, 0.35, 1, () => this.drawLadder(ship, ship.bay.z), false);
        }
      }
    }

    // --- the player's 3D pilot figure (wearing their avatar's 3D head/ears/visor/tail & colour-theme suit!)
    const activeZ = boarding ? selectedShip.bay.z + rolling * rolling * 18 : selectedShip.bay.z;
    const activeX = boarding ? lerp(selectedShip.bay.x, selectedShip.bay.x * 0.5, rolling) : selectedShip.bay.x;
    const syncMove = DANCE_MOVES[Math.floor(animTime / 2.2) % DANCE_MOVES.length]!;
    const playerPose =
      partyOn && !boarding && !this.reduceMotion
        ? {
            ...this.cadetDancePose(syncMove, START.x, START.z, Math.PI, animTime, 0),
            hat: pilotSpec.hangarHat,
          }
        : {
            ...this.pilotPose(selectedShip, activeX, activeZ, pilotSpec.hangarHat),
            happy: true,
            tailPhase: animTime * 6.5,
          };
    this.drawPilot(ink, pilotSpec, theme.hull, pilotSpec.colors.accent, 1, true, playerPose);
    if (partyOn && !boarding) {
      this.renderFloatingNotes(ink, START.x, START.z, animTime, 0, theme.hull);
    }

    // --- UI overlays for each stage
    if (this.stage === 'avatar') {
      this.renderAvatarStage(f);
    } else if (this.stage === 'theme') {
      this.renderThemeStage(f);
    } else if (this.stage === 'ship') {
      this.renderShipStage(f);
    } else {
      this.renderBoardingHud(f);
    }

    this.ctx = null;
  }

  /** Deep-space vignettes drifting past the open hangar bay door (clipped inside `clipSky`). */
  private renderDoorwaySpaceTraffic(ctx: CanvasRenderingContext2D, ink: HangarInk, animTime: number): void {
    const QUARTER = Math.PI / 2;

    // 1. Flight-School Duckling Line: instructor + 3 wobbling cadets (Swift, Starhawk, Bastion)
    const uSchool = (animTime / 14) % 1;
    if (uSchool < 0.72) {
      const progress = uSchool / 0.72;
      const wz = DEPTH + 42;
      const leadX = lerp(-18, 22, progress);
      const leadY = 9.4 + Math.sin(animTime * 1.5) * 0.55;
      if (this.flat(leadX, leadY, wz)) {
        const sc = clamp((this.focal * 0.095) / this.sd, 0.35, 0.85);
        const lx = this.sx;
        const ly = this.sy;
        ink(SAND, 0.48, 1.1, () => trace(ctx, SHIP, lx, ly, sc, QUARTER), false);
      }
      const cadetColors = [CYAN, LIME, YELLOW] as const;
      SHIP_IDS.forEach((cid, idx) => {
        const lag = idx === 2 ? Math.max(0, Math.sin(animTime * 0.95)) ** 3 * 2.4 : 0;
        const cx = leadX - (2.6 + idx * 2.5 + lag);
        const cy = 9.4 + Math.sin(animTime * 1.5 - (idx + 1) * 0.75) * 0.85 + Math.sin(animTime * 3.1 + idx) * 0.2;
        if (this.flat(cx, cy, wz)) {
          const sc = clamp((this.focal * 0.068) / this.sd, 0.25, 0.62);
          const sx = this.sx;
          const sy = this.sy;
          const rot = QUARTER + Math.sin(animTime * 2.4 + idx) * 0.16;
          ink(cadetColors[idx]!, 0.44, 1, () => trace(ctx, shipShape(cid), sx, sy, sc, rot), false);
        }
      });
    }

    // 2. Fuel Tanker Refuel Pass: tanker + curved fuel hose + drogue + customer ship
    const uTank = ((animTime + 6.5) / 16) % 1;
    if (uTank < 0.68) {
      const progress = uTank / 0.68;
      const wz = DEPTH + 56;
      const tx = lerp(19, -21, progress);
      const ty = 5.2 + Math.sin(animTime * 0.85) * 0.45;
      const cx = tx + 6.2 + Math.sin(animTime * 1.3) * 0.45;
      const cy = ty + Math.sin(animTime * 1.8 + 1) * 0.55;
      if (this.flat(tx, ty, wz)) {
        const sc = clamp((this.focal * 0.11) / this.sd, 0.36, 0.85);
        const tsx = this.sx;
        const tsy = this.sy;
        ink(LIME, 0.45, 1.1, () => trace(ctx, TANKER, tsx, tsy, sc, -QUARTER), false);
        if (this.flat(cx, cy, wz)) {
          const csx = this.sx;
          const csy = this.sy;
          const tailX = tsx + 20 * sc;
          const noseX = csx - 9 * sc;
          const sag = 6 * sc;
          ink(LIME, 0.36, 1, () => {
            ctx.moveTo(tailX, tsy);
            ctx.quadraticCurveTo((tailX + noseX) / 2, (tsy + csy) / 2 + sag, noseX, csy);
            trace(ctx, DROGUE, noseX, csy, sc * 0.68, -QUARTER);
          }, false);
          ink(SAND, 0.44, 1, () => trace(ctx, shipShape('swift'), csx, csy, sc * 0.76, -QUARTER), false);
        }
      }
    }

    // 3. Occasional streaking shooting star high in the doorway:
    const uComet = ((animTime + 2.2) / 9.5) % 1;
    if (uComet < 0.14) {
      const u = uComet / 0.14;
      const wz = DEPTH + 80;
      const hx = lerp(-16, 15, u);
      const hy = lerp(13.2, 6.8, u);
      for (let i = 0; i < 3; i++) {
        const alpha = (0.52 - i * 0.15) * Math.min(1, u * 5, (1 - u) * 3.5);
        ink(SAND, alpha, 1.1, () => {
          this.seg(hx - i * 1.6, hy + i * 0.68, wz, hx - (i + 1) * 1.6, hy + (i + 1) * 0.68, wz);
        }, false);
      }
    }
  }

  /** Spinning 3D low-poly disco ball & sweeping neon floor beams during the `KeyB` / `PARTY` Dance Party! */
  private renderDiscoBall(ink: HangarInk, animTime: number): void {
    const bx = 0;
    const by = 13.8;
    const bz = 18.5;
    const r = 1.15;
    const spin = animTime * 2.6;
    ink(SAND, 0.85, 1.2, () => {
      this.seg(bx, ROOF, bz, bx, by + r, bz);
      for (const lat of [-0.55, 0, 0.55]) {
        const ry = by + Math.sin(lat) * r;
        const rr = Math.cos(lat) * r;
        for (let i = 0; i < 8; i++) {
          const a0 = spin + (i * Math.PI) / 4;
          const a1 = spin + ((i + 1) * Math.PI) / 4;
          this.seg(bx + Math.cos(a0) * rr, ry, bz + Math.sin(a0) * rr, bx + Math.cos(a1) * rr, ry, bz + Math.sin(a1) * rr);
        }
      }
      for (let i = 0; i < 8; i++) {
        const a = spin + (i * Math.PI) / 4;
        const mx = bx + Math.cos(a) * r;
        const mz = bz + Math.sin(a) * r;
        this.seg(bx, by + r, bz, mx, by, mz);
        this.seg(mx, by, mz, bx, by - r, bz);
      }
    });
    const beamColors = [PINK, CYAN, YELLOW, LIME, VIOLET, ORANGE] as const;
    beamColors.forEach((col, i) => {
      const a = animTime * 1.9 + (i * Math.PI) / 3;
      const fx = Math.cos(a) * 14.5;
      const fz = 19 + Math.sin(a * 1.3) * 10.5;
      ink(col, 0.34, 1.2, () => {
        this.seg(bx, by - r * 0.6, bz, fx, 0.05, fz);
        this.seg(fx - 0.55, 0.05, fz, fx + 0.55, 0.05, fz);
        this.seg(fx, 0.05, fz - 0.55, fx, 0.05, fz + 0.55);
      }, false);
    });
  }

  private renderActionBox(f: HangarFrame, b: HangarBox | null, label: string, accentColor: string): void {
    if (!b) return;
    const { ctx, ink } = f;
    ctx.save();
    ctx.beginPath();
    cutRectPath(ctx, b, 6);
    ctx.fillStyle = 'rgba(3, 8, 30, 0.86)';
    ctx.fill();
    ctx.restore();
    const size = fitTo(label, 8.5, b.w - 14);
    ink(accentColor, 0.9, 1.3, () => {
      cutRectPath(ctx, b, 6);
      traceText(ctx, label, b.x + b.w / 2, b.y + b.h / 2 - size * 0.5, size, 'center');
    }, false);
  }

  private renderPickerActionBar(f: HangarFrame, accentColor: string): number {
    const ins = this.lastInset;
    const availW = Math.max(240, f.w - ins.left - ins.right - 24);
    const uiTop = ins.top + 62;
    const wideBar = this.stage === 'ship' ? availW >= 680 : availW >= 560;
    this.renderActionBox(f, this.navBtn, '< BACK', CYAN);
    this.renderActionBox(
      f,
      this.partyBtn,
      f.touch ? 'PARTY' : 'PARTY · B',
      this.dancePartyTimer > 0 ? YELLOW : PINK,
    );
    this.renderActionBox(f, this.quickFlyBtn, f.touch ? 'QUICK FLY' : 'QUICK FLY · F', accentColor);
    return wideBar ? uiTop + 4 : uiTop + 52;
  }

  private renderAvatarStage(f: HangarFrame): void {
    const { ctx, ink, w, h, time, touch } = f;
    const ins = this.lastInset;
    const availW = Math.max(240, w - ins.left - ins.right - 24);
    const titleRoom = availW >= 560 ? availW - 252 : availW - 8;

    // Dim the hangar gently so all 8 multi-colour low-poly faces pop clearly.
    ctx.fillStyle = 'rgba(3, 7, 26, 0.72)';
    ctx.fillRect(0, 0, w, h);

    const headerY = this.renderPickerActionBar(f, LIME);
    const titleSize = fitTo('CHOOSE YOUR PILOT', h < 500 ? 15 : 19, titleRoom);
    ink(CYAN, 1, 1.7, () => traceText(ctx, 'CHOOSE YOUR PILOT', w / 2, headerY, titleSize, 'center'));
    const sub = 'PICK ONCE - SAVED ON THIS DEVICE';
    const subSize = fitTo(sub, 8, titleRoom);
    ink(SAND, 0.68, 1.1, () => traceText(ctx, sub, w / 2, headerY + titleSize + 7, subSize, 'center'), false);

    this.avatarCards.forEach((card, i) => {
      const p = PILOTS[i]!;
      const focused = i === this.focusPilot;
      ctx.save();
      ctx.beginPath();
      cutRectPath(ctx, card, 10);
      ctx.fillStyle = focused ? 'rgba(10, 24, 68, 0.92)' : 'rgba(4, 10, 34, 0.84)';
      ctx.fill();
      ctx.restore();

      // Focused pilot performs the matching 3D signature emote (wink, nod, smile or fierce) for their tagline!
      const elapsedFocus = Math.max(0, this.clock - this.focusSince);
      const activeEmote =
        focused && this.activeTagline?.pilot === p.id && this.activeTagline.age < 3.2
          ? this.activeTagline
          : null;

      let mood: Mood;
      let yaw: number;
      let pitch: number;

      if (activeEmote) {
        const age = activeEmote.age;
        if (activeEmote.emote === 'wink') {
          mood = 'wink';
          yaw = this.reduceMotion ? 0.2 : 0.22 + Math.sin(age * 4.2) * 0.08;
          pitch = this.reduceMotion ? -0.04 : -0.05 + Math.sin(age * 6) * 0.03;
        } else if (activeEmote.emote === 'nod') {
          mood = !this.reduceMotion && age < 0.65 && Math.floor(age * 11) % 2 === 1 ? 'talk' : 'happy';
          yaw = this.reduceMotion ? 0.12 : Math.sin(age * 2.2) * 0.14;
          pitch = this.reduceMotion ? 0.11 : 0.04 + Math.sin(age * 14) * 0.22 * Math.max(0, 1 - age / 1.6);
        } else if (activeEmote.emote === 'fierce') {
          mood = 'fierce';
          yaw = this.reduceMotion
            ? -0.14
            : Math.sin(age * 15) * 0.13 * Math.max(0, 1 - age / 1.1) + Math.sin(age * 2) * 0.1;
          pitch = 0.12;
        } else {
          // 'smile'
          mood = !this.reduceMotion && age > 0.35 && age < 1.05 ? 'laugh' : 'happy';
          yaw = this.reduceMotion ? 0.16 : Math.sin(age * 3.1) * 0.25;
          pitch = this.reduceMotion ? -0.06 : -0.08 - Math.abs(Math.sin(age * 7)) * 0.05;
        }
      } else {
        mood = focused
          ? elapsedFocus < 0.85
            ? 'happy'
            : PREVIEW_MOODS[Math.floor((elapsedFocus - 0.85) / 1.15) % PREVIEW_MOODS.length]!
          : (Math.floor((time + i * 1.7) / 6) % 5 === 0 ? 'happy' : 'calm');
        yaw = this.reduceMotion
          ? (focused ? 0.16 : -0.1)
          : focused
            ? Math.sin(time * 1.8) * 0.34
            : Math.sin(time * 0.8 + i * 0.9) * 0.14;
        pitch = this.reduceMotion
          ? 0.04
          : focused && (mood === 'happy' || mood === 'laugh')
            ? -0.06 + Math.sin(time * 6) * 0.04
            : Math.sin(time * 1.1 + i) * 0.04;
      }

      const labelBand = card.h < 86 ? 22 : 28;
      const faceBox = Math.max(36, Math.min(card.w - 14, card.h - labelBand - 10));
      const fx = card.x + (card.w - faceBox) / 2;
      const fy = card.y + 6;

      renderAvatarFrame({
        ctx,
        ink,
        who: p.id,
        x: fx,
        y: fy,
        box: faceBox,
        yaw,
        pitch,
        mood,
        time,
        cyRatio: 0.5,
        sizeRatio: 0.31,
        headColor: p.colors.base,
        headAlpha: focused ? 0.88 : 0.65,
        headWidth: focused ? 1.35 : 1.05,
        faceColor: p.colors.face,
        faceWidth: focused ? 1.8 : 1.4,
        frameColor: focused ? p.colors.accent : p.colors.base,
        frameAlpha: focused ? 0.95 : 0.35,
        frameWidth: focused ? 1.6 : 1,
        frameGlow: focused,
      });

      const nameY = fy + faceBox + (card.h < 86 ? 5 : 6);
      const nameSize = fitTo(p.name, card.h < 86 ? 8.5 : 10, card.w - 10);
      ink(focused ? '#ffffff' : SAND, focused ? 1 : 0.82, focused ? 1.5 : 1.2, () =>
        traceText(ctx, p.name, card.x + card.w / 2, nameY, nameSize, 'center'),
      focused);

      if (card.h >= 82) {
        const tagSize = fitTo(p.tag, 6.8, card.w - 10);
        ink(p.colors.accent, focused ? 0.92 : 0.58, 1, () =>
          traceText(ctx, p.tag, card.x + card.w / 2, nameY + nameSize + 4, tagSize, 'center'),
        false);
      }

      if (!touch) {
        ink(p.colors.base, focused ? 0.9 : 0.4, 1, () =>
          traceText(ctx, String(i + 1), card.x + 8, card.y + 7, 7),
        false);
      }

      ink(focused ? p.colors.accent : p.colors.base, focused ? 1 : 0.38, focused ? 1.8 : 1.1, () =>
        cutRectPath(ctx, card, 10),
      focused);
    });

    // Glowing neon speech pill below the avatar grid showing the focused pilot's signature tagline:
    const focusedPilot = PILOTS[this.focusPilot]!;
    const tagText =
      this.activeTagline?.pilot === focusedPilot.id
        ? this.activeTagline.text
        : focusedPilot.taglines[0].text;
    const lastCard = this.avatarCards[this.avatarCards.length - 1];
    const cardsBottom = lastCard ? lastCard.y + lastCard.h : h - ins.bottom - 58;
    const hintY = h - ins.bottom - 16;
    const pillRoom = hintY - cardsBottom - 8;
    if (pillRoom >= 18) {
      const pillH = clamp(pillRoom - 2, 18, 25);
      const pillW = Math.min(availW, 500);
      const pill: HangarBox = {
        x: w / 2 - pillW / 2,
        y: cardsBottom + Math.max(3, (pillRoom - pillH) * 0.45),
        w: pillW,
        h: pillH,
      };
      ctx.save();
      ctx.beginPath();
      cutRectPath(ctx, pill, 6);
      ctx.fillStyle = 'rgba(6, 15, 48, 0.9)';
      ctx.fill();
      ctx.restore();
      const speech = `${focusedPilot.name}: '${tagText}'`;
      const speechSize = fitTo(speech, h < 500 ? 7.8 : 9, pill.w - 20);
      ink(focusedPilot.colors.accent, 0.85, 1.25, () => cutRectPath(ctx, pill, 6), false);
      ink(SAND, 0.96, 1.3, () =>
        traceText(ctx, speech, w / 2, pill.y + (pill.h - speechSize) / 2, speechSize, 'center'),
      false);
    }

    const hint = touch ? 'TAP A PILOT OR QUICK FLY' : 'HOVER TO HEAR · 1-8 · ARROWS + SPACE · F QUICK FLY';
    ink(SAND, 0.55, 1, () => traceText(ctx, hint, w / 2, hintY, fitTo(hint, 7.8, availW), 'center'), false);
  }

  private renderThemeStage(f: HangarFrame): void {
    const { ctx, ink, w, h, time, touch } = f;
    const ins = this.lastInset;
    const availW = Math.max(240, w - ins.left - ins.right - 24);
    const titleRoom = availW >= 560 ? availW - 252 : availW - 8;
    const activeTheme = THEMES[this.focusTheme] ?? THEME_BY_ID[this.loadout.theme];
    const pilot = PILOT_BY_ID[this.loadout.pilot];

    ctx.fillStyle = 'rgba(3, 7, 26, 0.7)';
    ctx.fillRect(0, 0, w, h);

    const headerY = this.renderPickerActionBar(f, activeTheme.hull);
    const titleSize = fitTo('PICK YOUR COLOR THEME', h < 500 ? 15 : 19, titleRoom);
    ink(activeTheme.hull, 1, 1.7, () => traceText(ctx, 'PICK YOUR COLOR THEME', w / 2, headerY, titleSize, 'center'));
    const sub = `${pilot.name} · STEP 2 OF 3`;
    ink(SAND, 0.72, 1.1, () => traceText(ctx, sub, w / 2, headerY + titleSize + 7, 8.5, 'center'), false);

    // Live Pilot + Tinted Ship Preview Strip:
    if (h >= 540) {
      const stripH = h >= 680 ? 78 : 60;
      const stripW = Math.min(availW, 420);
      const strip: HangarBox = { x: w / 2 - stripW / 2, y: headerY + titleSize + 22, w: stripW, h: stripH };
      ctx.save();
      ctx.beginPath();
      cutRectPath(ctx, strip, 10);
      ctx.fillStyle = 'rgba(6, 15, 48, 0.88)';
      ctx.fill();
      ctx.restore();
      ink(activeTheme.hull, 0.8, 1.4, () => cutRectPath(ctx, strip, 10));

      const faceSize = stripH - 12;
      renderAvatarFrame({
        ctx,
        ink,
        who: pilot.id,
        x: strip.x + 10,
        y: strip.y + 6,
        box: faceSize,
        yaw: this.reduceMotion ? 0.12 : Math.sin(time * 1.5) * 0.24,
        pitch: 0.03,
        mood: 'happy',
        time,
        headWidth: 1.25,
        faceWidth: 1.6,
        frameColor: activeTheme.hull,
        pilotConsole: true,
        consoleColor: activeTheme.hull,
      });

      const sx = strip.x + faceSize + (strip.w - faceSize) * 0.34;
      const sy = strip.y + stripH * 0.56;
      const sc = stripH >= 74 ? 1.15 : 0.92;
      const shape = shipShape(this.loadout.ship);
      ink(activeTheme.hull, 1, 1.7, () => trace(ctx, shape, sx, sy, sc, 0));
      ink(activeTheme.thruster, 1, 1.5, () => traceShipThrusters(ctx, this.loadout.ship, sx, sy, sc, 9));
      ink(activeTheme.bolt, 1, 1.8, () => {
        for (const dx of [-6, 6]) {
          ctx.moveTo(sx + dx * sc, sy - 14 * sc);
          ctx.lineTo(sx + dx * sc, sy - 25 * sc);
        }
      });

      const previewLabelX = sx + 36 * sc;
      const maxLblW = Math.max(60, strip.x + strip.w - previewLabelX - 10);
      const previewName = fitTo(activeTheme.name, 11, maxLblW);
      ink(activeTheme.hull, 1, 1.4, () => traceText(ctx, activeTheme.name, previewLabelX, strip.y + stripH * 0.28, previewName));
      ink(activeTheme.thruster, 0.88, 1.1, () => traceText(ctx, 'HULL + THRUSTERS', previewLabelX, strip.y + stripH * 0.62, fitTo('HULL + THRUSTERS', 7.2, maxLblW)), false);
    }

    this.themeCards.forEach((card, i) => {
      const th = THEMES[i]!;
      const focused = i === this.focusTheme;
      ctx.save();
      ctx.beginPath();
      cutRectPath(ctx, card, 9);
      ctx.fillStyle = focused ? 'rgba(10, 24, 68, 0.92)' : 'rgba(4, 10, 34, 0.84)';
      ctx.fill();
      ctx.restore();

      const midX = card.x + card.w / 2;
      const shipY = card.y + card.h * 0.42;
      const sc = card.h < 76 ? 0.82 : 1;
      const shape = shipShape(this.loadout.ship);

      ink(th.bolt, focused ? 1 : 0.78, 1.7, () => {
        ctx.moveTo(midX - 6 * sc, shipY - 10 * sc);
        ctx.lineTo(midX - 6 * sc, shipY - 19 * sc);
        ctx.moveTo(midX + 6 * sc, shipY - 10 * sc);
        ctx.lineTo(midX + 6 * sc, shipY - 19 * sc);
      });
      ink(th.hull, focused ? 1 : 0.82, focused ? 1.7 : 1.35, () => trace(ctx, shape, midX, shipY, sc, 0), focused);
      ink(th.thruster, focused ? 1 : 0.8, 1.4, () => traceShipThrusters(ctx, this.loadout.ship, midX, shipY, sc, 7.5));

      const labelSize = fitTo(th.name, 9, card.w - 14);
      ink(focused ? '#ffffff' : th.hull, focused ? 1 : 0.85, focused ? 1.4 : 1.15, () =>
        traceText(ctx, th.name, midX, card.y + card.h - labelSize - 8, labelSize, 'center'),
      focused);

      if (!touch) {
        ink(th.hull, focused ? 0.9 : 0.45, 1, () => traceText(ctx, String(i + 1), card.x + 8, card.y + 7, 7), false);
      }

      ink(th.hull, focused ? 1 : 0.4, focused ? 1.8 : 1.1, () => cutRectPath(ctx, card, 9), focused);
    });

    const hint = touch ? 'TAP A COLOR THEME' : '1-6 · ARROWS + SPACE · BACKSPACE';
    ink(SAND, 0.55, 1, () => traceText(ctx, hint, w / 2, h - ins.bottom - 20, fitTo(hint, 8, availW), 'center'), false);
  }

  private renderShipStage(f: HangarFrame): void {
    const { ctx, ink, w, h, touch } = f;
    const ins = this.lastInset;
    const availW = Math.max(240, w - ins.left - ins.right - 24);
    const theme = THEME_BY_ID[this.loadout.theme];

    const headerY = this.renderPickerActionBar(f, theme.hull);

    // Top banner with subtle dark backing pill so the 3D hangar stays wide open underneath!
    const maxBannerW = availW >= 680 ? availW - 380 : availW;
    const bannerW = Math.min(maxBannerW, 430);
    const banner: HangarBox = { x: w / 2 - bannerW / 2, y: headerY - 4, w: bannerW, h: h < 500 ? 40 : 46 };
    ctx.save();
    ctx.beginPath();
    cutRectPath(ctx, banner, 8);
    ctx.fillStyle = 'rgba(3, 8, 30, 0.82)';
    ctx.fill();
    ctx.restore();
    ink(theme.hull, 0.7, 1.2, () => cutRectPath(ctx, banner, 8), false);

    const headText = touch ? 'TAP YOUR SHIP CARD TO BOARD' : 'CHOOSE A SHIP TO BOARD';
    const titleSize = fitTo(headText, h < 500 ? 12.5 : 15.5, bannerW - 24);
    ink(theme.hull, 1, 1.6, () => traceText(ctx, headText, w / 2, banner.y + 7, titleSize, 'center'));
    const sub = 'EACH SHIP HAS ITS OWN SPEED, ARMOR AND CANNONS';
    ink(SAND, 0.72, 1, () => traceText(ctx, sub, w / 2, banner.y + 10 + titleSize, fitTo(sub, 7.2, bannerW - 20), 'center'), false);

    // Subtle targeting brackets around the currently focused 3D ship in the hangar:
    const targetBox = this.shipTargets[this.focusShip];
    if (targetBox && targetBox.w > 0) {
      ink(theme.hull, 0.85, 1.4, () => {
        const arm = 12;
        const { x, y, w: bw, h: bh } = targetBox;
        ctx.moveTo(x, y + arm); ctx.lineTo(x, y); ctx.lineTo(x + arm, y);
        ctx.moveTo(x + bw - arm, y); ctx.lineTo(x + bw, y); ctx.lineTo(x + bw, y + arm);
        ctx.moveTo(x, y + bh - arm); ctx.lineTo(x, y + bh); ctx.lineTo(x + arm, y + bh);
        ctx.moveTo(x + bw - arm, y + bh); ctx.lineTo(x + bw, y + bh); ctx.lineTo(x + bw, y + bh - arm);
      });
    }

    // Three >= 52px tall 2D Bay Stat Cards along the bottom, with top-down silhouette preview + stat pips:
    this.shipPlaques.forEach((plaque, i) => {
      const ship = SHIPS[i]!;
      const focused = i === this.focusShip;
      ctx.save();
      ctx.beginPath();
      cutRectPath(ctx, plaque, 8);
      ctx.fillStyle = focused ? 'rgba(10, 24, 68, 0.92)' : 'rgba(4, 10, 34, 0.84)';
      ctx.fill();
      ctx.restore();

      const midX = plaque.x + plaque.w / 2;
      const topY = plaque.y + 7;
      // Mini 2D top-down silhouette icon beside the ship name so the player sees the 2D shape too!
      const iconScale = plaque.w < 126 ? 0.5 : 0.65;
      ink(focused ? theme.hull : CYAN, focused ? 1 : 0.75, 1.3, () =>
        trace(ctx, shipShape(ship.id), plaque.x + 14, topY + 9, iconScale, 0),
      focused);

      const title = !touch && plaque.w >= 130 ? `${i + 1} ${ship.name}` : ship.name;
      const nameSize = fitTo(title, 9.5, plaque.w - 28);
      ink(focused ? '#ffffff' : SAND, 1, focused ? 1.45 : 1.15, () =>
        traceText(ctx, title, midX + 7, topY + 2, nameSize, 'center'),
      focused);

      const roleSize = fitTo(ship.role, 6.8, plaque.w - 12);
      ink(focused ? theme.accent : CYAN, 0.88, 1, () =>
        traceText(ctx, ship.role, midX, topY + 17, roleSize, 'center'),
      false);

      // 3 rows of 5-pip stat bars: ARM (Armor), WPN (Weapon), SPD (Speed)
      const stats: readonly [string, number, string][] = [
        ['ARM', ship.bars.armor, theme.hull],
        ['WPN', ship.bars.fire, theme.bolt],
        ['SPD', ship.bars.speed, theme.thruster],
      ];
      const rowStart = topY + (plaque.h < 92 ? 31 : 35);
      const rowStep = plaque.h < 92 ? 14 : 17;
      const labelLeft = plaque.x + 8;
      const barLeft = plaque.x + (plaque.w < 120 ? 34 : 40);
      const barRight = plaque.x + plaque.w - 8;
      const pipGap = 3;
      const pipW = Math.max(4, (barRight - barLeft - pipGap * 4) / 5);

      stats.forEach(([lbl, filled, col], rIdx) => {
        const ry = rowStart + rIdx * rowStep;
        ink(SAND, 0.72, 1, () => traceText(ctx, lbl, labelLeft, ry, 6.8), false);
        ink(col, 0.95, 2.2, () => {
          for (let p = 0; p < filled; p++) {
            const px = barLeft + p * (pipW + pipGap);
            ctx.moveTo(px, ry + 3.5);
            ctx.lineTo(px + pipW, ry + 3.5);
          }
        }, false);
        if (filled < 5) {
          ink(SAND, 0.22, 1.4, () => {
            for (let p = filled; p < 5; p++) {
              const px = barLeft + p * (pipW + pipGap);
              ctx.moveTo(px, ry + 3.5);
              ctx.lineTo(px + pipW, ry + 3.5);
            }
          }, false);
        }
      });

      if (plaque.h >= 96) {
        const wpnSize = fitTo(ship.weapon, 6.5, plaque.w - 12);
        ink(SAND, 0.65, 1, () =>
          traceText(ctx, ship.weapon, midX, plaque.y + plaque.h - 11, wpnSize, 'center'),
        false);
      }

      ink(focused ? theme.hull : CYAN, focused ? 1 : 0.38, focused ? 1.8 : 1.1, () =>
        cutRectPath(ctx, plaque, 8),
      focused);
    });
  }

  private renderBoardingHud(f: HangarFrame): void {
    const { ctx, ink, w, h, touch } = f;
    const ins = this.lastInset;

    const title = smooth((this.t - 0.5) / 0.6) * (1 - smooth((this.t - 3.6) / 0.6));
    if (title > 0) {
      const size = fitTo('TIME FOR FLIGHT CLASS', 16, w - ins.left - ins.right - 40);
      ink(CYAN, title, 1.6, () => traceText(ctx, 'TIME FOR FLIGHT CLASS', w / 2, Math.max(ins.top + 66, h * 0.09), size, 'center'));
    }
    const hint = touch ? 'TAP TO SKIP · HANGAR BUTTON TO CUSTOMIZE' : 'SPACE TO SKIP · H TO CUSTOMIZE';
    ink(SAND, 0.48 * smooth((this.t - 0.8) / 0.5), 1, () =>
      traceText(ctx, hint, w / 2, h - ins.bottom - 26, fitTo(hint, 8, w - 32), 'center'),
    false);
  }

  // ----------------------------------------------------------------- pilot boarding path

  private pilotPose(
    ship: (typeof SHIPS)[number],
    shipX: number,
    shipZ: number,
    hat: HangarHat,
  ): Pose {
    const base = { pack: true, hat };
    if (this.stage !== 'boarding') {
      // Standing ready at START, facing the currently highlighted ship bay!
      const focusBay = SHIPS[this.focusShip]?.bay ?? ship.bay;
      return person({
        ...base,
        x: START.x,
        z: START.z,
        face: Math.atan2(focusBay.x - START.x, focusBay.z - START.z),
        stride: null,
      });
    }

    const t = this.t;
    const side = ship.bay.ladderSide;
    const lx = ship.bay.x + side * (ship.id === 'bastion' ? 2.05 : 1.72);
    const lz = ship.bay.z + 0.45;
    const footX = lx + side * 0.72;
    const topX = lx - side * 0.42;
    const climbFace = side > 0 ? -Math.PI / 2 : Math.PI / 2;

    if (t < WALK_TO) {
      const u = clamp((t - WALK_FROM) / (WALK_TO - WALK_FROM), 0, 1);
      const walking = t > WALK_FROM;
      return person({
        ...base,
        x: lerp(START.x, footX, u),
        z: lerp(START.z, lz, u),
        face: Math.atan2(footX - START.x, lz - START.z),
        stride: walking ? (t - WALK_FROM) * STRIDES : null,
      });
    }
    if (t < CLIMBED) {
      const u = (t - WALK_TO) / (CLIMBED - WALK_TO);
      return person({
        ...base,
        x: lerp(footX, topX, u),
        y: lerp(0, 1.25, u),
        z: lz,
        face: climbFace,
        stride: (t - WALK_TO) * 9,
        climbing: true,
      });
    }
    const u = smooth((t - CLIMBED) / (SEATED - CLIMBED));
    return person({
      ...base,
      x: lerp(topX, shipX, u),
      y: lerp(1.25, SEAT_Y, u),
      z: lerp(lz, shipZ + 0.2, u),
      face: lerp(climbFace, 0, u),
      seated: u > 0.5,
    });
  }
}

/** What a screen reader is told is happening. */
export const HANGAR_SCRIPT =
  'The hangar of Space Pilot School, on a space station. Your pilot walks across the hangar floor to their ship and climbs in. Press H or the Hangar button to change pilot, colour theme or ship.';
export const HANGAR_PICKER_SCRIPT =
  'The hangar of Space Pilot School. Step 1 of 3: pick your pilot face, colour theme and one of three ships, or use Quick Fly to board right away.';
