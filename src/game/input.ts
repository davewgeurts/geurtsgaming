/**
 * The keyboard, the mouse and the touch screen.
 *
 * This keeps track of what is held down (which keys, and where a steering finger is) and works out what a
 * key or a tap is for at the level of "a question might want this", "this is a command", "this picked
 * something". What those mean in the game (which question, pause or the leaderboard, which box) is asked
 * of the game through `InputHost`.
 */
import type { Box } from './hud';

/** The keys the game uses to fly, fire and give commands. They are kept from the page. */
const GAME_KEYS = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'KeyW', 'KeyA', 'KeyS', 'KeyD',
  'Space', 'Enter', 'KeyP', 'KeyL', 'KeyC',
]);

/** Keys that would scroll the page behind the game; swallowed while it is open. */
const SCROLL_KEYS = new Set(['PageUp', 'PageDown', 'Home', 'End']);

/** How far above a steering finger the ship rides, so the finger does not cover it. */
const FINGER_LIFT = 64;

/** Which of these boxes, if any, the point (x, y) is in, with a little slack for fingers. */
export function boxAt(x: number, y: number, boxes: readonly Box[], slack = 4): number | null {
  const index = boxes.findIndex((b) => x >= b.x - slack && x <= b.x + b.w + slack && y >= b.y - slack && y <= b.y + b.h + slack);
  return index < 0 ? null : index;
}

/** What the input can ask of the game. */
export interface InputHost {
  /** A key or a click has arrived: the browser will let the game make sound from now on. */
  wake(): void;
  /** Esc: the player wants to leave. */
  exit(): void;
  /** Whether typing this character would answer an open question or pick something on offer. */
  wants(key: string): boolean;
  /** Give the game a character that `wants` said yes to. */
  type(key: string): void;
  /**
   * One of the game's keys has gone down. Returns true if it was a command (pause, the leaderboard) and so
   * is not to be treated as held down.
   */
  command(code: string): boolean;
  /** A click or tap at (x, y) on the canvas. Returns true if it picked something: an answer, an upgrade, a boss's ship. */
  pick(x: number, y: number): boolean;
  /** A finger has gone down to steer, so the player has no keys. */
  touched(): void;
  /** A click or tap that picked nothing: resume, launch, or try again. */
  press(): void;
  /** Optional physical-to-logical arena coordinate mapper (used in Co-op `3:4` arena mode). */
  mapPoint?(x: number, y: number): { x: number; y: number };
  /** Optional custom pointer handlers (used by `CoopThumbDeck` on portrait phones). */
  pointerDown?(pointerId: number, x: number, y: number, touch: boolean): boolean;
  pointerMove?(pointerId: number, x: number, y: number): boolean;
  pointerUp?(pointerId: number): boolean;
  pointerDrop?(): void;
  /** Allow focused HTML `<button>` controls (e.g. Co-op Leave confirmation sheet) to receive `Space`. */
  allowButtonSpace?: boolean;
}

/** The part of a canvas this needs: somewhere to listen, and where it is on the page. */
export interface Surface extends EventTarget {
  getBoundingClientRect(): { left: number; top: number };
  setPointerCapture?(pointerId: number): void;
}

/** True when the event happened on a button, which keeps its own Enter and Space. */
const onButton = (e: Event): boolean => (e.target as { tagName?: string } | null)?.tagName === 'BUTTON';

export class Input {
  /** The keys held down now, by their `code`. */
  readonly keys = new Set<string>();
  /** How the player last steered. Typing is only asked of players at a keyboard. */
  mode: 'keys' | 'touch';
  /** Where the steering finger wants the ship, or where it last did. */
  readonly touch = { x: 0, y: 0 };
  private touchId: number | null = null;
  /** Where the canvas's top left corner is in the window, measured when it is laid out and on each press. */
  private origin = { x: 0, y: 0 };

  private readonly keyboard: EventTarget;
  private readonly surface: Surface;
  private readonly host: InputHost;

  /** `keyboard` is where key events arrive (the window), `surface` the canvas, `mode` how the player is expected to steer. */
  constructor(keyboard: EventTarget, surface: Surface, host: InputHost, mode: 'keys' | 'touch') {
    this.keyboard = keyboard;
    this.surface = surface;
    this.host = host;
    this.mode = mode;
    keyboard.addEventListener('keydown', this.onKeyDown);
    keyboard.addEventListener('keyup', this.onKeyUp);
    keyboard.addEventListener('blur', this.letGo);
    surface.addEventListener('pointerdown', this.onPointerDown);
    surface.addEventListener('pointermove', this.onPointerMove);
    surface.addEventListener('pointerup', this.onPointerUp);
    surface.addEventListener('pointercancel', this.onPointerUp);
  }

  /** Stop listening. */
  detach(): void {
    this.keyboard.removeEventListener('keydown', this.onKeyDown);
    this.keyboard.removeEventListener('keyup', this.onKeyUp);
    this.keyboard.removeEventListener('blur', this.letGo);
    this.surface.removeEventListener('pointerdown', this.onPointerDown);
    this.surface.removeEventListener('pointermove', this.onPointerMove);
    this.surface.removeEventListener('pointerup', this.onPointerUp);
    this.surface.removeEventListener('pointercancel', this.onPointerUp);
  }

  /** Which way the keys are steering across the screen: -1 (left), 0 or 1. */
  get across(): number {
    const k = this.keys;
    return (k.has('ArrowRight') || k.has('KeyD') ? 1 : 0) - (k.has('ArrowLeft') || k.has('KeyA') ? 1 : 0);
  }

  /** Which way the keys are steering down the screen: -1 (up), 0 or 1. */
  get down(): number {
    const k = this.keys;
    return (k.has('ArrowDown') || k.has('KeyS') ? 1 : 0) - (k.has('ArrowUp') || k.has('KeyW') ? 1 : 0);
  }

  /** A finger is on the screen, steering. */
  get touching(): boolean {
    return this.touchId !== null;
  }

  /** The player is holding fire: Space, or a finger on the screen. */
  get firing(): boolean {
    return this.keys.has('Space') || this.touchId !== null;
  }

  /** Forget every key that is held: the window has lost the keyboard, or the game has changed scene. */
  letGo = (): void => {
    this.keys.clear();
  };

  /** Forget the keys and the steering finger too. */
  drop(): void {
    this.keys.clear();
    this.touchId = null;
    this.host.pointerDrop?.();
  }

  /** Measure where the canvas is in the window. */
  measure(): void {
    const box = this.surface.getBoundingClientRect();
    this.origin = { x: box.left, y: box.top };
  }

  private onKeyDown = (event: Event): void => {
    const e = event as KeyboardEvent;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    this.host.wake();
    const code = e.code;
    if (code === 'Escape') {
      e.preventDefault();
      this.host.exit();
      return;
    }
    if (SCROLL_KEYS.has(code)) {
      e.preventDefault();
      return;
    }
    // Enter still activates a focused button (Exit). Space always belongs to the game in Solo,
    // so tabbing to Exit and then firing cannot end a run by accident; in Co-op, dialog/control buttons keep Space too.
    if ((code === 'Enter' || (code === 'Space' && this.host.allowButtonSpace)) && onButton(e)) return;

    // A key that answers the open question goes to the question. It is matched on the character, not the
    // physical key, so a line can be typed on any keyboard layout. Everything else (arrow keys, and any
    // key once the answer is in) falls through, so a key held ready for the wave still counts.
    if (this.host.wants(e.key)) {
      e.preventDefault();
      if (!e.repeat) {
        this.mode = 'keys';
        this.host.type(e.key);
      }
      return;
    }

    if (!GAME_KEYS.has(code)) return;
    e.preventDefault();
    if (e.repeat) return;
    this.mode = 'keys';
    this.keys.add(code);
    if (this.host.command(code)) this.keys.delete(code);
  };

  private onKeyUp = (event: Event): void => {
    const e = event as KeyboardEvent;
    // A button is clicked when Space is released on it; see onKeyDown for why that is blocked in Solo.
    if (e.code === 'Space' && !this.host.allowButtonSpace && onButton(e)) e.preventDefault();
    this.keys.delete(e.code);
  };

  private onPointerDown = (event: Event): void => {
    const e = event as PointerEvent;
    const touch = e.pointerType !== 'mouse';
    // Only the main mouse button plays; the others are the browser's.
    if (!touch && e.button !== 0) return;
    this.host.wake();
    this.measure();
    const rawX = e.clientX - this.origin.x;
    const rawY = e.clientY - this.origin.y;
    if (this.host.pointerDown?.(e.pointerId, rawX, rawY, touch)) {
      if (touch) this.mode = 'touch';
      try {
        this.surface.setPointerCapture?.(e.pointerId);
      } catch {
        /* capture is a nicety, not a requirement */
      }
      return;
    }
    const pt = this.host.mapPoint ? this.host.mapPoint(rawX, rawY) : { x: rawX, y: rawY };
    // A click or tap on an upgrade, an answer or a boss's little ship picks it, and is not a steering touch.
    if (this.host.pick(pt.x, pt.y)) {
      if (touch) this.mode = 'touch';
      return;
    }
    if (touch) {
      this.mode = 'touch';
      this.host.touched();
      this.touchId = e.pointerId;
      this.track(e);
      try {
        this.surface.setPointerCapture?.(e.pointerId);
      } catch {
        /* capture is a nicety, not a requirement */
      }
    }
    this.host.press();
  };

  private onPointerMove = (event: Event): void => {
    const e = event as PointerEvent;
    if (this.host.pointerMove?.(e.pointerId, e.clientX - this.origin.x, e.clientY - this.origin.y)) {
      return;
    }
    if (e.pointerId === this.touchId) this.track(e);
  };

  private onPointerUp = (event: Event): void => {
    const pid = (event as PointerEvent).pointerId;
    this.host.pointerUp?.(pid);
    if (pid === this.touchId) this.touchId = null;
  };

  /** The ship rides a little above the finger so the finger does not cover it. */
  private track(e: PointerEvent): void {
    const rawX = e.clientX - this.origin.x;
    const rawY = e.clientY - this.origin.y;
    if (this.host.mapPoint) {
      const pt = this.host.mapPoint(rawX, rawY);
      this.touch.x = pt.x;
      this.touch.y = pt.y - FINGER_LIFT;
    } else {
      this.touch.x = rawX;
      this.touch.y = rawY - FINGER_LIFT;
    }
  }
}
