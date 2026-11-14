/**
 * The set pieces in a wave: the fuel ship, then the flight commander's warning and the asteroid field.
 *
 * This is the part that decides when each one starts, runs it, and says what it was worth. How the fuel ship
 * flies is in tanker.ts and how a field is laid out is in asteroids.ts; hud.ts and game.ts draw them.
 * Nothing here draws or touches the page: what the game should do about each thing that happens (a sound,
 * some points, a line for a screen reader) is asked of it through `SetPieceEnv`.
 */
import { createField, randomFieldSeed, updateField, type Field, type FieldEnv, type Rock } from './asteroids';
import type { Mood } from './avatar';
import { NEON, PEBBLE, ROCK, SAND, percent } from './core';
import { BRIEFING } from './lines';
import type { Shape } from './shapes';
import type { Sfx } from './sound';
import { FUEL_SECONDS, createTanker, dismissTanker, updateTanker, type Tanker, type TankerEnv } from './tanker';

/** Points for filling the tank from the fuel ship. */
export const FULL_TANK_POINTS = 400;
/** Points for breaking a little rock and a tough one, for getting through a field, and for doing it without a scratch. */
export const PEBBLE_POINTS = 20;
export const ROCK_POINTS = 150;
export const FIELD_POINTS = 150;
export const CLEAN_FIELD_POINTS = 400;

/**
 * The commander's warning: how long it is on screen, when the commander turns from the alarm to the choice
 * of ways through, and how far in the asteroids set off.
 */
export const ALERT_SECONDS = 6;
export const ALERT_TURN = 2.4;
export const ALERT_LEAD = 3.4;

/** Seconds a set piece waits for the sky to clear before it comes anyway. */
export const DUE_PATIENCE = 12;

/** A set piece, and the moment in the wave (in seconds on the wave's clock) at which it is due. */
export interface Stop { at: number; kind: 'fuel' | 'rocks' }

/** What the set pieces know of the game, and what they can ask of it. */
export interface SetPieceEnv {
  // Brought up to date by the game each time it is asked for:
  w: number;
  h: number;
  top: number;
  left: number;
  right: number;
  scale: number;
  pace: number;
  shipScale: number;
  wave: number;
  /** The game's clock, in seconds. */
  time: number;
  /** False once the game is over. Set pieces still fly off the screen then, but pay nothing. */
  playing: boolean;
  shipX: number;
  shipY: number;
  // Made once:
  play(sound: Sfx): void;
  /** A line for the screen reader. */
  say(message: string): void;
  /** The flight commander says this over the radio, out loud. */
  radio(text: string): void;
  /** The pilot calls this out. */
  call(text: string): void;
  /** Set the pilot's expression. A `soft` feeling does not wipe a wince off the pilot's face. */
  feel(mood: Mood, seconds: number, soft?: boolean): void;
  award(points: number): void;
  /** Add to the energy gauge, which stops at full (1). */
  charge(amount: number): void;
  ring(x: number, y: number, color: string, reach: number): void;
  spark(x: number, y: number, color: string): void;
  burst(shape: Shape, x: number, y: number, rot: number, color: string): void;
  /** Put a bomb into the asteroid field. It rides down with the rocks, at `ride` px a second. */
  bomb(x: number, y: number, ride: number): void;
  /** Put a power-up into the asteroid field. `last` is the one at the far end of the hard way: the big prize. */
  capsule(x: number, y: number, ride: number, last: boolean): void;
  /** When true, generates deterministic seeded asteroid fields and fires co-op set-piece hooks. */
  seeded?: boolean;
  onTankerStart?(wave: number): void;
  onFieldAlarm?(wave: number, seed: number): void;
  onFieldStart?(wave: number, seed: number): void;
  onRockBroken?(rock: Rock): void;
}

export class SetPieces {
  /** The set pieces still to come in this wave, in order. */
  stops: Stop[] = [];
  /** The one waiting for a clear sky before it starts, and how long it has waited. */
  due: Stop['kind'] | null = null;
  dueWait = 0;
  tanker: Tanker | null = null;
  /** The asteroid field, the rocks of it that are on screen, and how many times it has hit the ship. */
  field: Field | null = null;
  fieldSeed: number | null = null;
  readonly brokenRockIds: number[] = [];
  readonly near: Rock[] = [];
  fieldHits = 0;
  /** Seconds the commander's asteroid warning has been up, or null when it is not. */
  alert: number | null = null;
  /** A line about how the refuelling or the asteroids went, and when it fades. */
  note = { text: '', until: 0, color: SAND };

  private readonly fuelEnv: TankerEnv = { w: 0, h: 0, top: 0, left: 0, right: 0, scale: 1, noseX: 0, noseY: 0 };
  private readonly rockEnv: FieldEnv = { w: 0, h: 0, left: 0, right: 0, scale: 1, pace: 1, wave: 1 };

  /** A new wave: nothing on screen, and these set pieces to come. */
  plan(stops: Stop[]): void {
    this.tanker = null;
    this.field = null;
    this.fieldSeed = null;
    this.brokenRockIds.length = 0;
    this.near.length = 0;
    this.alert = null;
    this.due = null;
    this.stops = stops;
  }

  /** A new game. */
  reset(): void {
    this.plan([]);
    this.note.until = 0;
  }

  /** The game is over: nothing more is due, and a fuel ship that is here leaves. A field keeps on falling. */
  stop(): void {
    this.due = null;
    this.stops = [];
    this.alert = null;
    this.note.until = 0;
    if (this.tanker) dismissTanker(this.tanker);
  }

  /**
   * Move the wave's clock on by `dt`, but never past the next set piece. Reaching it makes that set piece due:
   * it starts once the sky is clear (see `run`), and the wave's clock stands still until it is over.
   */
  advance(waveTime: number, dt: number): number {
    const next = this.stops[0]?.at ?? Infinity;
    const now = Math.min(waveTime + dt, next);
    if (now >= next) {
      this.due = this.stops.shift()!.kind;
      this.dueWait = 0;
    }
    return now;
  }

  /**
   * Run whichever set piece is on, or start the one that is due once there are no `enemies` left (or it has
   * waited long enough) and no question is open. Returns true while a set piece has hold of the wave, which
   * is when nothing else in it moves on. `dt` is the world's time, `real` the clock's.
   */
  run(dt: number, real: number, env: SetPieceEnv, enemies: number, asking: boolean): boolean {
    if (this.tanker) {
      this.flyTanker(dt, env);
      return true;
    }
    if (this.field || this.alert !== null) {
      this.flyField(dt, real, env);
      return true;
    }
    if (!this.due) return false;
    this.dueWait += dt;
    if (!asking && (!enemies || this.dueWait > DUE_PATIENCE)) {
      if (this.due === 'fuel') this.callTanker(env);
      else this.raiseAlarm(env);
      this.due = null;
    }
    return true;
  }

  /** After the game is over: whatever is still on screen flies off. */
  coast(dt: number, real: number, env: SetPieceEnv): void {
    if (this.tanker) this.flyTanker(dt, env);
    if (this.field) this.flyField(dt, real, env);
  }

  /** What the fuel ship knows of the game. Also what is needed to draw it. */
  tankerEnv(env: SetPieceEnv): TankerEnv {
    const fuel = this.fuelEnv;
    fuel.w = env.w;
    fuel.h = env.h;
    fuel.top = env.top;
    fuel.left = env.left;
    fuel.right = env.right;
    fuel.scale = env.scale;
    fuel.noseX = env.shipX;
    fuel.noseY = env.shipY - 16 * env.shipScale;
    return fuel;
  }

  private fieldEnv(env: SetPieceEnv, seed?: number): FieldEnv {
    const rocks = this.rockEnv;
    rocks.w = env.w;
    rocks.h = env.h;
    rocks.left = env.left;
    rocks.right = env.right;
    rocks.scale = env.scale;
    rocks.pace = env.pace;
    rocks.wave = env.wave;
    rocks.seed = seed;
    return rocks;
  }

  private callTanker(env: SetPieceEnv): void {
    this.tanker = createTanker(env.wave, this.tankerEnv(env));
    env.play('tanker');
    env.say(`A fuel ship has arrived. Fly up behind it, catch the end of its fuel line with the nose of the ship, and stay hooked on for ${FUEL_SECONDS} seconds. It will not hold still.`);
    env.onTankerStart?.(env.wave);
  }

  /** Fly the fuel ship, and pay out its fuel: energy for as long as the line is on, and a bonus for a full tank. */
  private flyTanker(dt: number, env: SetPieceEnv): void {
    const t = this.tanker;
    if (!t) return;
    const event = updateTanker(t, dt, this.tankerEnv(env));
    const note = (text: string, color: string, seconds = 1.8) => {
      this.note = { text, until: env.time + seconds, color };
    };
    if (t.hooked && env.playing) {
      env.charge(dt / FUEL_SECONDS);
      env.play('pump');
    }
    if (event === 'hook') {
      env.play('hook');
      env.feel('happy', 0.8, true);
      if (!t.snaps) env.say('Fuel line hooked on. Stay with the fuel ship.');
    } else if (event === 'snap') {
      env.play('snap');
      env.spark(env.shipX, env.shipY - 16 * env.shipScale, NEON.red);
      env.feel('worried', 1, true);
      env.call(t.why === 'close' ? 'TOO CLOSE' : 'TOO FAR');
      env.say(`The fuel line came off: too ${t.why === 'close' ? 'close' : 'far away'}. Catch it again.`);
    } else if (event === 'full') {
      env.charge(1);
      env.award(FULL_TANK_POINTS);
      env.feel('happy', 1.4);
      env.play('power');
      env.ring(env.shipX, env.shipY, NEON.lime, 120 * env.scale);
      note(`FULL TANK +${FULL_TANK_POINTS}`, NEON.lime, 2);
      env.call('FULL TANK');
      env.say('Tank full. Cannons at full power.');
    } else if (event === 'leave') {
      note(t.fuel > 0 ? `FUEL SHIP LEAVING - TANK ${percent(t.fuel)}% FULL` : 'THE FUEL SHIP COULD NOT WAIT', SAND);
      env.say('The fuel ship has left.');
    }
    if (t.state === 'gone') this.tanker = null;
  }

  /** The flight commander bursts in, worried: asteroids ahead. The field itself sets off a moment later. */
  private raiseAlarm(env: SetPieceEnv): void {
    this.alert = 0;
    this.fieldSeed = env.seeded ? randomFieldSeed() : null;
    this.brokenRockIds.length = 0;
    env.play('alarm');
    env.radio(BRIEFING.asteroids.join(' '));
    env.feel('worried', ALERT_TURN + 1);
    env.say(
      `Flight commander: ${BRIEFING.asteroids.join(' ')} ${BRIEFING.choice.join(' ')} An asteroid field is coming down the screen, with two winding ways through. ` +
      'The easy way is wide and has bombs in it, which ask a question if touched. The hard way is narrow and has power-ups instead. ' +
      'Little rocks break in one shot; the rest take many.',
    );
    if (this.fieldSeed !== null) {
      env.onFieldAlarm?.(env.wave, this.fieldSeed);
    }
  }

  private startField(env: SetPieceEnv): void {
    if (env.seeded && this.fieldSeed === null) {
      this.fieldSeed = randomFieldSeed();
    }
    const f = createField(this.fieldEnv(env, this.fieldSeed ?? undefined));
    this.field = f;
    this.fieldHits = 0;
    this.brokenRockIds.length = 0;
    for (const b of f.bombs) env.bomb(b.x, f.front - b.d, f.speed);
    // The hard way's power-ups: boosts, and at the far end the big prize.
    f.prizes.forEach((p, i) => env.capsule(p.x, f.front - p.d, f.speed, i === f.prizes.length - 1));
    if (this.fieldSeed !== null) {
      env.onFieldStart?.(env.wave, this.fieldSeed);
    }
  }

  /** Run the warning and then the asteroid field. */
  private flyField(dt: number, real: number, env: SetPieceEnv): void {
    if (this.alert !== null) {
      const was = this.alert;
      this.alert += dt;
      if (was < ALERT_TURN && this.alert >= ALERT_TURN) {
        env.play('radio');
        env.radio(BRIEFING.choice.join(' '));
      }
      if (was < ALERT_LEAD && this.alert >= ALERT_LEAD) this.startField(env);
      if (this.alert >= ALERT_SECONDS) this.alert = null;
    }
    const f = this.field;
    if (!f) return;
    updateField(f, dt, real, this.fieldEnv(env, f.seed));
    if (f.rocks.some((rock) => rock.dead)) f.rocks = f.rocks.filter((rock) => !rock.dead);
    // Only the rocks on screen are drawn or can be hit.
    this.near.length = 0;
    for (const rock of f.rocks) {
      const y = f.front - rock.d;
      if (y > -rock.r - 8 && y < env.h + rock.r + 8) this.near.push(rock);
    }
    if (!f.done) return;
    this.field = null;
    this.fieldSeed = null;
    this.brokenRockIds.length = 0;
    this.near.length = 0;
    if (!env.playing) return;
    const clean = this.fieldHits === 0;
    const points = clean ? CLEAN_FIELD_POINTS : FIELD_POINTS;
    env.award(points);
    this.note = { text: `${clean ? 'NOT A SCRATCH' : 'THROUGH THE ASTEROIDS'} +${points}`, until: env.time + 2, color: clean ? NEON.lime : SAND };
    env.feel('happy', 1.4);
    env.play('right');
    env.call(clean ? 'NOT A SCRATCH' : 'THROUGH THE ASTEROIDS');
    env.say(`Through the asteroid field${clean ? ' without a scratch' : ''}.`);
  }

  /** The rock, if any, that a shot at (x, y) has landed on. */
  rockAt(x: number, y: number): Rock | null {
    const f = this.field;
    if (!f) return null;
    return this.near.find((r) => !r.dead && Math.hypot(x - r.x, y - (f.front - r.d)) < r.r + 2) ?? null;
  }

  /** The rock, if any, that a ship of this `radius` at (x, y) has flown into. */
  rockTouching(x: number, y: number, radius: number): Rock | null {
    const f = this.field;
    if (!f) return null;
    return this.near.find((r) => !r.dead && Math.hypot(r.x - x, f.front - r.d - y) < r.r * 0.9 + radius) ?? null;
  }

  /** A shot has landed on a rock. Little ones break; on the rest it mostly just sparks. */
  hitRock(rock: Rock, x: number, y: number, env: SetPieceEnv): void {
    rock.hp -= 1;
    rock.flash = 0.08;
    if (rock.hp <= 0) {
      this.breakRock(rock, env);
    } else if (rock.tough) {
      env.spark(x, y, ROCK);
      env.play('clang');
    } else {
      env.play('hit');
    }
  }

  breakRock(rock: Rock, env: SetPieceEnv): void {
    if (rock.dead || !this.field) return;
    rock.dead = true;
    this.brokenRockIds.push(rock.id);
    env.award(rock.tough ? ROCK_POINTS : PEBBLE_POINTS);
    env.burst(rock.shape, rock.x, this.field.front - rock.d, rock.rot, rock.tough ? ROCK : PEBBLE);
    env.play('boom');
    env.onRockBroken?.(rock);
  }

  /** Break a rock by deterministic `Rock.id` on a co-op Guest (playing burst + boom if still present). */
  breakRockById(rockId: number, env: SetPieceEnv): void {
    const f = this.field;
    if (!f) return;
    const rock = f.rocks.find((r) => r.id === rockId && !r.dead);
    if (!rock) return;
    rock.dead = true;
    this.brokenRockIds.push(rock.id);
    env.burst(rock.shape, rock.x, f.front - rock.d, rock.rot, rock.tough ? ROCK : PEBBLE);
    env.play('boom');
  }

  /** Trigger the Flight Commander's asteroid warning on a co-op Guest with the Host's chosen seed. */
  startSyncedFieldAlarm(seed: number, env: SetPieceEnv): void {
    this.fieldSeed = seed >>> 0;
    this.brokenRockIds.length = 0;
    this.alert = 0;
    env.play('alarm');
    env.radio(BRIEFING.asteroids.join(' '));
    env.feel('worried', ALERT_TURN + 1);
  }

  /**
   * Synchronize a co-op Guest's asteroid belt with the Host's authoritative seed, front position,
   * warning clock, and already-broken rock IDs (used both during flight and on mid-field reconnect).
   */
  syncFieldState(
    wave: number,
    seed: number,
    front: number | null,
    alert: number | null,
    brokenIds: readonly number[],
    env: SetPieceEnv,
  ): void {
    const cleanSeed = seed >>> 0;
    const cleanWave = Number.isFinite(wave) ? Math.max(1, Math.min(99, Math.round(wave))) : 1;
    const cleanAlert =
      alert === null || !Number.isFinite(alert) ? null : Math.max(0, Math.min(20, alert));
    this.fieldSeed = cleanSeed;
    this.alert = cleanAlert;
    if (front === null || !Number.isFinite(front)) {
      this.field = null;
      this.near.length = 0;
      return;
    }
    const cleanFront = Math.max(-2000, Math.min(40000, front));
    if (!this.field || this.field.seed !== cleanSeed) {
      const fEnv = this.fieldEnv(env, cleanSeed);
      fEnv.wave = cleanWave;
      this.field = createField(fEnv);
      this.fieldHits = 0;
    }
    this.field.front = cleanFront;
    if (brokenIds.length > 0) {
      const deadSet = new Set(brokenIds);
      for (const rock of this.field.rocks) {
        if (deadSet.has(rock.id)) rock.dead = true;
      }
      if (this.field.rocks.some((r) => r.dead)) {
        this.field.rocks = this.field.rocks.filter((r) => !r.dead);
      }
    }
    this.refreshNearRocks(env.h);
  }

  /** Recompute `this.near` from `this.field.front` for Guest rendering without spawning Host pickups. */
  refreshNearRocks(viewH: number): void {
    this.near.length = 0;
    const f = this.field;
    if (!f) return;
    for (const rock of f.rocks) {
      if (rock.dead) continue;
      const y = f.front - rock.d;
      if (y > -rock.r - 8 && y < viewH + rock.r + 8) this.near.push(rock);
    }
  }

  /** The ship has flown into a rock: a little one breaks on it, and the field has left its mark. */
  scrape(rock: Rock, env: SetPieceEnv): void {
    if (!rock.tough) this.breakRock(rock, env);
    this.fieldHits += 1;
  }

  /** A blast clears the little rocks on screen. The tough ones shrug it off. */
  blast(env: SetPieceEnv): void {
    for (const rock of this.near) if (!rock.tough) this.breakRock(rock, env);
  }
}
