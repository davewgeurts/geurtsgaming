/**
 * Co-op `3:4` (`768 x 1024`) viewport calculator and portrait-phone Bottom 38% Thumb Steering Deck.
 *
 * Ergonomics rule:
 * - On portrait phones (`isCoarse && viewportW < 600 && viewportH > viewportW * 1.08`), the bottom ~38%
 *   of the screen is reserved as a dedicated Thumb Steering Deck so the player's thumb never covers
 *   low-flying hazards, wingmen, or the shared `3:4` arena above it.
 * - On laptops, tablets (`>= 600px` wide), and landscape screens, `deckHeight = 0` and the `3:4` arena
 *   centers cleanly at full viewport height with side HUD rails.
 */

import {
  COOP_ARENA_HEIGHT,
  COOP_ARENA_WIDTH,
  COOP_SEAT_COLORS,
  type CoopSeatIndex,
} from './coop-types';
import { NEON, PINK, SAND, clamp, strokeInk as ink } from './core';
import { fitTo, traceText } from './font';
import { GRADE_BANDS } from './questions';
import { trace } from './shapes';
import type { Upgrade } from './upgrades';

export interface SafeInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface ScreenBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CoopViewportLayout {
  viewportW: number;
  viewportH: number;
  /** True on portrait phones where the bottom 38% Thumb Steering Deck is active. */
  useThumbDeck: boolean;
  /** Screen-space box where the `768 x 1024` (`3:4`) arena is rendered (`w / h === 0.75`). */
  arenaRect: ScreenBox;
  /** Uniform scale mapping `768 x 1024` world units to CSS pixels (`arenaRect.w / 768`). */
  arenaScale: number;
  /** Height of the bottom Thumb Steering Deck (`0` when `useThumbDeck` is false). */
  deckHeight: number;
  /** Full bottom deck box (`h === 0` when inactive). */
  deckRect: ScreenBox;
  /** Interactive trackpad surface inside `deckRect`. */
  padRect: ScreenBox;
  /** Optional tap-toggle pill inside `deckRect` that latches continuous cannon fire. */
  autoFireBtnRect: ScreenBox;
}

const ZERO_INSETS: SafeInsets = { top: 0, right: 0, bottom: 0, left: 0 };

/**
 * Compute exact screen geometry for the shared `768 x 1024` (`3:4`) arena and optional
 * portrait-phone Bottom 38% Thumb Steering Deck.
 */
export function computeCoopViewportLayout(
  viewportW: number,
  viewportH: number,
  isCoarse: boolean,
  insets: SafeInsets = ZERO_INSETS,
): CoopViewportLayout {
  const vw = Math.max(240, viewportW);
  const vh = Math.max(320, viewportH);
  const useThumbDeck = isCoarse && vw < 600 && vh > vw * 1.08;

  const deckHeight = useThumbDeck
    ? clamp(Math.round(vh * 0.38), 185, Math.min(360, Math.floor(vh * 0.42)))
    : 0;

  const topPad = Math.max(insets.top, 8);
  const bottomPad = useThumbDeck ? 4 : Math.max(8, insets.bottom);
  const sidePad = Math.max(4, Math.max(insets.left, insets.right));

  const availW = Math.max(120, vw - sidePad * 2);
  const availH = Math.max(160, vh - deckHeight - topPad - bottomPad);

  const scale = Math.min(availW / COOP_ARENA_WIDTH, availH / COOP_ARENA_HEIGHT);
  const arenaW = COOP_ARENA_WIDTH * scale;
  const arenaH = COOP_ARENA_HEIGHT * scale;
  const arenaX = (vw - arenaW) / 2;
  const arenaY = topPad + (availH - arenaH) / 2;

  const deckY = vh - deckHeight;
  const deckRect: ScreenBox = {
    x: 0,
    y: deckY,
    w: vw,
    h: deckHeight,
  };

  const padMarginX = clamp(Math.round(vw * 0.04), 10, 20);
  const headerH = useThumbDeck ? 52 : 0;
  const padBottom = Math.max(10, insets.bottom + 8);
  const padRect: ScreenBox = useThumbDeck
    ? {
        x: padMarginX,
        y: deckY + headerH,
        w: Math.max(140, vw - padMarginX * 2),
        h: Math.max(92, deckHeight - headerH - padBottom),
      }
    : { x: 0, y: vh, w: 0, h: 0 };

  const btnW = useThumbDeck ? Math.min(142, Math.round(vw * 0.37)) : 0;
  const autoFireBtnRect: ScreenBox = useThumbDeck
    ? {
        x: vw - padMarginX - btnW,
        y: deckY + 4,
        w: btnW,
        h: 44,
      }
    : { x: 0, y: vh, w: 0, h: 0 };

  return {
    viewportW: vw,
    viewportH: vh,
    useThumbDeck,
    arenaRect: { x: arenaX, y: arenaY, w: arenaW, h: arenaH },
    arenaScale: scale,
    deckHeight,
    deckRect,
    padRect,
    autoFireBtnRect,
  };
}

/** Map a screen pointer `(clientX, clientY)` into `768 x 1024` logical world coordinates. */
export function clientToArenaPoint(
  layout: CoopViewportLayout,
  clientX: number,
  clientY: number,
): { x: number; y: number; inside: boolean } {
  const { arenaRect, arenaScale } = layout;
  const s = Math.max(0.0001, arenaScale);
  const rawX = (clientX - arenaRect.x) / s;
  const rawY = (clientY - arenaRect.y) / s;
  const inside =
    clientX >= arenaRect.x &&
    clientX <= arenaRect.x + arenaRect.w &&
    clientY >= arenaRect.y &&
    clientY <= arenaRect.y + arenaRect.h;
  return {
    x: clamp(rawX, 18, COOP_ARENA_WIDTH - 18),
    y: clamp(rawY, 24, COOP_ARENA_HEIGHT - 24),
    inside,
  };
}

/** Map a `768 x 1024` logical world point `(worldX, worldY)` to CSS viewport coordinates. */
export function arenaToClientPoint(
  layout: CoopViewportLayout,
  worldX: number,
  worldY: number,
): { x: number; y: number } {
  return {
    x: layout.arenaRect.x + worldX * layout.arenaScale,
    y: layout.arenaRect.y + worldY * layout.arenaScale,
  };
}

function pointInRect(r: ScreenBox, x: number, y: number, pad = 0): boolean {
  return x >= r.x - pad && x <= r.x + r.w + pad && y >= r.y - pad && y <= r.y + r.h + pad;
}

export type CoopDeckCardView =
  | {
      kind: 'grade';
      interactive: boolean;
      /** Seconds until the youngest band is picked for the pilot (absent: no timer shown). */
      timeLeft?: number;
      timeLimit?: number;
    }
  | {
      kind: 'choice';
      title: string;
      titleColor: string;
      question: string;
      options: readonly string[];
      correctIndex: number;
      pickedIndex: number | null;
      done: boolean;
      interactive: boolean;
      timeLeft: number;
      timeLimit: number;
      note: string;
      noteColor: string;
    }
  | {
      kind: 'offer';
      upgrades: readonly Upgrade[];
      interactive: boolean;
    }
  | {
      kind: 'result';
      headline: string;
      subline: string;
      color: string;
    };

/** Compute interactive button boxes inside `layout.padRect` for an active portrait-phone deck card. */
export function deckCardBoxes(layout: CoopViewportLayout, card: CoopDeckCardView): ScreenBox[] {
  const { padRect } = layout;
  if (!layout.useThumbDeck || padRect.w <= 0 || padRect.h <= 0) return [];
  const innerX = padRect.x + 10;
  const innerW = Math.max(100, padRect.w - 20);

  if (card.kind === 'grade') {
    const count = GRADE_BANDS.length;
    const topY = padRect.y + 38;
    const availH = Math.max(132, padRect.h - 46);
    const gap = 6;
    const rowH = clamp(Math.floor((availH - gap * (count - 1)) / count), 40, 56);
    return Array.from({ length: count }, (_, i) => ({
      x: innerX,
      y: topY + i * (rowH + gap),
      w: innerW,
      h: rowH,
    }));
  }

  if (card.kind === 'offer') {
    const count = card.upgrades.length;
    if (count === 0) return [];
    const topY = padRect.y + 30;
    const availH = Math.max(132, padRect.h - 38);
    const gap = 6;
    const rowH = clamp(Math.floor((availH - gap * (count - 1)) / count), 40, 58);
    return Array.from({ length: count }, (_, i) => ({
      x: innerX,
      y: topY + i * (rowH + gap),
      w: innerW,
      h: rowH,
    }));
  }

  if (card.kind === 'choice') {
    const count = card.options.length;
    if (count === 0) return [];
    const gap = 8;
    const bw = Math.max(54, Math.floor((innerW - gap * (count - 1)) / count));
    const totalW = bw * count + gap * (count - 1);
    const x0 = padRect.x + (padRect.w - totalW) / 2;
    const boxH = clamp(Math.round(padRect.h * 0.34), 48, 68);
    const boxY = padRect.y + Math.round(padRect.h * 0.38);
    return Array.from({ length: count }, (_, i) => ({
      x: x0 + i * (bw + gap),
      y: boxY,
      w: bw,
      h: boxH,
    }));
  }

  return [];
}

/** Return the tapped option/row index (`0..n-1`) if `(clientX, clientY)` hits an interactive deck card button. */
export function hitTestDeckCard(
  layout: CoopViewportLayout,
  card: CoopDeckCardView | null,
  clientX: number,
  clientY: number,
): number | null {
  if (!card || card.kind === 'result' || !card.interactive) return null;
  const boxes = deckCardBoxes(layout, card);
  for (let i = 0; i < boxes.length; i++) {
    if (pointInRect(boxes[i]!, clientX, clientY, 2)) return i;
  }
  return null;
}

export interface ThumbDeckState {
  /** Desired world X (`18..750`) in the shared `768 x 1024` arena. */
  targetX: number;
  /** Desired world Y (`24..1000`) in the shared `768 x 1024` arena. */
  targetY: number;
  /** True while the pilot's thumb is steering on the deck. */
  touching: boolean;
  /** True when cannons should fire (thumb held on pad OR Auto-Fire latch active). */
  firing: boolean;
  /** True when the optional Auto-Fire latch toggle is enabled. */
  autoFireLatch: boolean;
}

/**
 * Relative-trackpad controller and neon vector renderer for the Bottom 38% Thumb Steering Deck.
 *
 * - Sliding a thumb across `~65%` of the pad width sweeps the full `768 px` arena width with 0ms lag,
 *   so pilots never have to stretch a thumb to screen edges or obscure the playfield.
 * - Taps inside `arenaRect` above the deck emit one-shot world taps (e.g. choosing a Sum Boss pod)
 *   without interrupting an active steering thumb on the deck.
 */
export class CoopThumbDeck {
  private targetX = COOP_ARENA_WIDTH / 2;
  private targetY = COOP_ARENA_HEIGHT - 140;
  private activePointerId: number | null = null;
  private originClientX = 0;
  private originClientY = 0;
  private puckClientX = 0;
  private puckClientY = 0;
  private lastClientX = 0;
  private lastClientY = 0;
  private autoFireLatch = false;
  private pendingArenaTap: { x: number; y: number } | null = null;

  reset(x = COOP_ARENA_WIDTH / 2, y = COOP_ARENA_HEIGHT - 140): void {
    this.targetX = clamp(x, 18, COOP_ARENA_WIDTH - 18);
    this.targetY = clamp(y, 24, COOP_ARENA_HEIGHT - 24);
    this.activePointerId = null;
    this.pendingArenaTap = null;
  }

  syncTarget(x: number, y: number): void {
    if (this.activePointerId !== null) return;
    this.targetX = clamp(x, 18, COOP_ARENA_WIDTH - 18);
    this.targetY = clamp(y, 24, COOP_ARENA_HEIGHT - 24);
  }

  releasePointer(clearAutoFire = false): void {
    this.activePointerId = null;
    if (clearAutoFire) this.autoFireLatch = false;
  }

  consumeArenaTap(): { x: number; y: number } | null {
    const tap = this.pendingArenaTap;
    this.pendingArenaTap = null;
    return tap;
  }

  state(): ThumbDeckState {
    const touching = this.activePointerId !== null;
    return {
      targetX: this.targetX,
      targetY: this.targetY,
      touching,
      firing: touching || this.autoFireLatch,
      autoFireLatch: this.autoFireLatch,
    };
  }

  /**
   * Handle `pointerdown` in CSS viewport coordinates. Returns `true` if consumed by the deck or arena tap.
   */
  onPointerDown(
    layout: CoopViewportLayout,
    pointerId: number,
    clientX: number,
    clientY: number,
    allowArenaTap = true,
  ): boolean {
    if (!layout.useThumbDeck) return false;

    if (pointInRect(layout.autoFireBtnRect, clientX, clientY, 4)) {
      this.autoFireLatch = !this.autoFireLatch;
      return true;
    }

    if (clientY >= layout.deckRect.y - 4) {
      if (this.activePointerId === null) {
        this.activePointerId = pointerId;
        this.originClientX = clamp(
          clientX,
          layout.padRect.x + 24,
          layout.padRect.x + layout.padRect.w - 24,
        );
        this.originClientY = clamp(
          clientY,
          layout.padRect.y + 24,
          layout.padRect.y + layout.padRect.h - 24,
        );
        this.puckClientX = this.originClientX;
        this.puckClientY = this.originClientY;
        this.lastClientX = clientX;
        this.lastClientY = clientY;
      }
      return true;
    }

    if (allowArenaTap) {
      const worldPt = clientToArenaPoint(layout, clientX, clientY);
      if (worldPt.inside) {
        this.pendingArenaTap = { x: worldPt.x, y: worldPt.y };
      }
    }

    // In thumb-deck flight, swallow upper-arena touches so Input never starts direct finger-follow steering.
    return true;
  }

  onPointerMove(
    layout: CoopViewportLayout,
    pointerId: number,
    clientX: number,
    clientY: number,
  ): boolean {
    if (!layout.useThumbDeck || this.activePointerId !== pointerId) return false;

    const dx = clientX - this.lastClientX;
    const dy = clientY - this.lastClientY;
    this.lastClientX = clientX;
    this.lastClientY = clientY;

    const gainX = COOP_ARENA_WIDTH / Math.max(110, layout.padRect.w * 0.65);
    const gainY = COOP_ARENA_HEIGHT / Math.max(95, layout.padRect.h * 0.85);
    this.targetX = clamp(this.targetX + dx * gainX, 22, COOP_ARENA_WIDTH - 22);
    this.targetY = clamp(this.targetY + dy * gainY, 44, COOP_ARENA_HEIGHT - 28);

    const maxDeflect = 42;
    const vx = clientX - this.originClientX;
    const vy = clientY - this.originClientY;
    const dist = Math.hypot(vx, vy);
    if (dist > maxDeflect && dist > 0) {
      this.puckClientX = this.originClientX + (vx / dist) * maxDeflect;
      this.puckClientY = this.originClientY + (vy / dist) * maxDeflect;
    } else {
      this.puckClientX = clientX;
      this.puckClientY = clientY;
    }
    return true;
  }

  onPointerUp(pointerId: number): boolean {
    if (this.activePointerId !== pointerId) return false;
    this.activePointerId = null;
    return true;
  }

  /** Render the Bottom 38% Thumb Steering Deck in CSS viewport space (`ctx` transformed by `dpr` only). */
  render(
    ctx: CanvasRenderingContext2D,
    layout: CoopViewportLayout,
    info: {
      seat: CoopSeatIndex;
      callsign: string;
      hull: number;
      maxHull: number;
      alive: boolean;
      respawnSec: number;
      answering?: boolean;
      gameOver?: boolean;
      card?: CoopDeckCardView | null;
      wingmen?: ReadonlyArray<{
        seat: CoopSeatIndex;
        connected: boolean;
        alive: boolean;
        hull: number;
        answering?: boolean;
      }>;
    },
  ): void {
    if (!layout.useThumbDeck) return;

    const seatColor = COOP_SEAT_COLORS[info.seat] ?? NEON.cyan;
    const { deckRect, padRect, autoFireBtnRect } = layout;

    ctx.save();
    ctx.fillStyle = 'rgba(3, 8, 30, 0.92)';
    ctx.fillRect(deckRect.x, deckRect.y, deckRect.w, deckRect.h);

    // Top divider beam separating the 3:4 arena from the thumb deck
    ink(ctx, seatColor, 0.7, 1.5, () => {
      ctx.moveTo(0, deckRect.y + 0.5);
      ctx.lineTo(deckRect.w, deckRect.y + 0.5);
    });

    // Pilot seat badge + hull pips + compact squadmate tags on left of header
    const leftAvailW = Math.max(80, autoFireBtnRect.x - padRect.x - 12);
    const badge = `P${info.seat + 1} - ${info.callsign}`;
    const badgeSize = fitTo(badge, 9.5, leftAvailW);
    ink(ctx, seatColor, 0.95, 1.5, () => {
      traceText(ctx, badge, padRect.x, deckRect.y + 7, badgeSize, 'left');
    });

    const pipY = deckRect.y + 22;
    for (let i = 0; i < info.maxHull; i++) {
      const filled = i < info.hull;
      const px = padRect.x + i * 14;
      ink(
        ctx,
        filled ? seatColor : SAND,
        filled ? 0.95 : 0.25,
        1.4,
        () => {
          ctx.rect(px, pipY, 10, 5);
        },
        filled,
      );
    }

    if (info.wingmen && info.wingmen.length > 0) {
      const tagW = Math.min(64, leftAvailW / info.wingmen.length);
      info.wingmen.forEach((w, idx) => {
        const wColor = w.answering ? NEON.yellow : (COOP_SEAT_COLORS[w.seat] ?? SAND);
        const wTag = !w.connected
          ? `P${w.seat + 1} WAIT`
          : !w.alive
            ? `P${w.seat + 1} OUT`
            : w.answering
              ? `P${w.seat + 1} QUIZ`
              : `P${w.seat + 1} ${w.hull}HP`;
        ink(ctx, wColor, w.connected ? 0.88 : 0.45, 1.15, () => {
          traceText(ctx, wTag, padRect.x + idx * tagW, deckRect.y + 34, 5.8, 'left');
        }, false);
      });
    }

    // Auto-Fire latch button
    const latchOn = this.autoFireLatch;
    ctx.fillStyle = latchOn ? 'rgba(155, 255, 77, 0.16)' : 'rgba(66, 245, 255, 0.06)';
    ctx.fillRect(autoFireBtnRect.x, autoFireBtnRect.y, autoFireBtnRect.w, autoFireBtnRect.h);
    ink(ctx, latchOn ? NEON.lime : SAND, latchOn ? 0.9 : 0.45, 1.3, () => {
      ctx.rect(autoFireBtnRect.x, autoFireBtnRect.y, autoFireBtnRect.w, autoFireBtnRect.h);
    });
    const latchLabel = latchOn ? 'AUTO-FIRE: ON' : 'AUTO-FIRE: OFF';
    const latchSize = fitTo(latchLabel, 8.5, autoFireBtnRect.w - 14);
    ink(
      ctx,
      latchOn ? NEON.lime : SAND,
      latchOn ? 0.95 : 0.75,
      1.3,
      () => {
        traceText(
          ctx,
          latchLabel,
          autoFireBtnRect.x + autoFireBtnRect.w / 2,
          autoFireBtnRect.y + (autoFireBtnRect.h - latchSize) / 2,
          latchSize,
          'center',
        );
      },
      false,
    );

    // Trackpad frame + subtle cyber grid (or active Question / Grade / Upgrade Card!)
    const activeCard = !info.gameOver ? (info.card ?? null) : null;
    ctx.fillStyle = activeCard ? 'rgba(6, 14, 48, 0.94)' : 'rgba(7, 17, 54, 0.72)';
    ctx.fillRect(padRect.x, padRect.y, padRect.w, padRect.h);
    const frameStroke = activeCard ? NEON.yellow : seatColor;
    ink(ctx, frameStroke, activeCard || this.activePointerId !== null ? 0.88 : 0.42, 1.5, () => {
      ctx.rect(padRect.x, padRect.y, padRect.w, padRect.h);
    });

    if (activeCard) {
      this.renderDeckCard(ctx, layout, activeCard);
      ctx.restore();
      return;
    }

    ink(
      ctx,
      seatColor,
      0.1,
      1,
      () => {
        const cols = 4;
        const rows = 3;
        for (let c = 1; c < cols; c++) {
          const gx = padRect.x + (padRect.w * c) / cols;
          ctx.moveTo(gx, padRect.y + 4);
          ctx.lineTo(gx, padRect.y + padRect.h - 4);
        }
        for (let r = 1; r < rows; r++) {
          const gy = padRect.y + (padRect.h * r) / rows;
          ctx.moveTo(padRect.x + 4, gy);
          ctx.lineTo(padRect.x + padRect.w - 4, gy);
        }
      },
      false,
    );

    if (!info.alive) {
      const msg = info.gameOver
        ? 'SQUAD DOWN'
        : info.respawnSec > 0
          ? `WINGMAN REBOOT IN ${Math.ceil(info.respawnSec)} SEC`
          : 'HULL DOWN - STAND BY';
      const sz = fitTo(msg, 11, padRect.w - 24);
      ink(ctx, NEON.orange, 0.9, 1.5, () => {
        traceText(
          ctx,
          msg,
          padRect.x + padRect.w / 2,
          padRect.y + padRect.h / 2 - sz / 2,
          sz,
          'center',
        );
      });
    } else if (this.activePointerId !== null) {
      ink(ctx, seatColor, 0.35, 1.4, () => {
        ctx.arc(this.originClientX, this.originClientY, 28, 0, Math.PI * 2);
      });
      ink(ctx, seatColor, 0.6, 1.5, () => {
        ctx.moveTo(this.originClientX, this.originClientY);
        ctx.lineTo(this.puckClientX, this.puckClientY);
      });
      ink(ctx, seatColor, 0.95, 2, () => {
        ctx.arc(this.puckClientX, this.puckClientY, 15, 0, Math.PI * 2);
      });
    } else {
      const hint = 'SLIDE THUMB TO FLY - HOLD TO FIRE';
      const hintSize = fitTo(hint, 9.5, padRect.w - 28);
      ink(
        ctx,
        SAND,
        0.55,
        1.3,
        () => {
          traceText(
            ctx,
            hint,
            padRect.x + padRect.w / 2,
            padRect.y + padRect.h / 2 - hintSize / 2,
            hintSize,
            'center',
          );
        },
        false,
      );
    }

    ctx.restore();
  }

  private renderDeckCard(
    ctx: CanvasRenderingContext2D,
    layout: CoopViewportLayout,
    card: CoopDeckCardView,
  ): void {
    const { padRect } = layout;
    const cx = padRect.x + padRect.w / 2;

    if (card.kind === 'grade') {
      const title = 'WHAT GRADE ARE YOU IN, PILOT?';
      const titleSz = fitTo(title, 9.5, padRect.w - 20);
      ink(ctx, NEON.cyan, 0.96, 1.5, () => {
        traceText(ctx, title, cx, padRect.y + 8, titleSz, 'center');
      });
      const sub =
        card.timeLeft !== undefined
          ? `SETS YOUR QUESTION LEVEL - NEVER SAVED - CLOSES IN ${Math.max(0, Math.ceil(card.timeLeft))}`
          : 'SETS YOUR QUESTION LEVEL - NEVER SAVED';
      const subSz = fitTo(sub, 6.5, padRect.w - 20);
      ink(ctx, SAND, 0.72, 1.1, () => {
        traceText(ctx, sub, cx, padRect.y + 22, subSz, 'center');
      }, false);

      const boxes = deckCardBoxes(layout, card);
      boxes.forEach((b, i) => {
        const band = GRADE_BANDS[i]!;
        ctx.fillStyle = 'rgba(56, 189, 248, 0.08)';
        ctx.fillRect(b.x, b.y, b.w, b.h);
        ink(ctx, NEON.cyan, 0.85, 1.4, () => {
          ctx.rect(b.x, b.y, b.w, b.h);
        });
        const labelSz = fitTo(band.label, 10.5, b.w * 0.62);
        ink(ctx, SAND, 0.96, 1.5, () => {
          traceText(ctx, band.label, b.x + 12, b.y + (b.h - labelSz) / 2, labelSz, 'left');
        });
        const ageSz = fitTo(band.ages, 7.5, b.w * 0.3);
        ink(ctx, NEON.cyan, 0.9, 1.2, () => {
          traceText(ctx, band.ages, b.x + b.w - 12, b.y + (b.h - ageSz) / 2, ageSz, 'right');
        }, false);
      });
      return;
    }

    if (card.kind === 'offer') {
      const title = 'CORRECT - TAP AN UPGRADE FOR SQUAD';
      const titleSz = fitTo(title, 9, padRect.w - 20);
      ink(ctx, NEON.lime, 0.96, 1.5, () => {
        traceText(ctx, title, cx, padRect.y + 9, titleSz, 'center');
      });
      const boxes = deckCardBoxes(layout, card);
      boxes.forEach((b, i) => {
        const u = card.upgrades[i]!;
        ctx.fillStyle = 'rgba(155, 255, 77, 0.08)';
        ctx.fillRect(b.x, b.y, b.w, b.h);
        ink(ctx, NEON.lime, 0.85, 1.4, () => {
          ctx.rect(b.x, b.y, b.w, b.h);
          trace(ctx, u.icon, b.x + 4 + b.h / 2, b.y + b.h / 2, b.h / 42, 0);
        });
        const textX = b.x + b.h + 8;
        const availW = Math.max(60, b.w - b.h - 16);
        const nameSz = fitTo(u.name, 9.5, availW);
        const blurbSz = fitTo(u.blurb, 6.8, availW);
        ink(ctx, NEON.lime, 0.96, 1.4, () => {
          traceText(ctx, u.name, textX, b.y + b.h * 0.24, nameSz, 'left');
        });
        ink(ctx, SAND, 0.82, 1.1, () => {
          traceText(ctx, u.blurb, textX, b.y + b.h * 0.62, blurbSz, 'left');
        }, false);
      });
      return;
    }

    if (card.kind === 'result') {
      const hSz = fitTo(card.headline, 13, padRect.w - 24);
      ink(ctx, card.color, 0.96, 1.7, () => {
        traceText(ctx, card.headline, cx, padRect.y + padRect.h * 0.36 - hSz / 2, hSz, 'center');
      });
      if (card.subline) {
        const sSz = fitTo(card.subline, 8.5, padRect.w - 24);
        ink(ctx, SAND, 0.85, 1.2, () => {
          traceText(ctx, sSz > 0 ? card.subline : '', cx, padRect.y + padRect.h * 0.58, sSz, 'center');
        }, false);
      }
      return;
    }

    // `card.kind === 'choice'`
    const titleSz = fitTo(card.title, 8.5, padRect.w - 20);
    ink(ctx, card.titleColor, 0.95, 1.4, () => {
      traceText(ctx, card.title, cx, padRect.y + 10, titleSz, 'center');
    });

    const eq = `${card.question} = ?`;
    const eqSz = fitTo(eq, 17, padRect.w - 24);
    ink(ctx, SAND, 0.98, 1.8, () => {
      traceText(ctx, eq, cx, padRect.y + Math.round(padRect.h * 0.17), eqSz, 'center');
    });

    const boxes = deckCardBoxes(layout, card);
    boxes.forEach((b, i) => {
      const isCorrect = card.done && i === card.correctIndex;
      const isWrong = card.done && card.pickedIndex === i && i !== card.correctIndex;
      const stroke = isCorrect ? PINK : isWrong ? NEON.red : NEON.cyan;
      const alpha = card.done && !isCorrect && !isWrong ? 0.35 : 0.95;
      ctx.fillStyle = isCorrect
        ? 'rgba(255, 94, 168, 0.16)'
        : 'rgba(56, 189, 248, 0.08)';
      ctx.fillRect(b.x, b.y, b.w, b.h);
      ink(ctx, stroke, alpha, isCorrect ? 2.2 : 1.5, () => {
        ctx.rect(b.x, b.y, b.w, b.h);
        if (isWrong) {
          ctx.moveTo(b.x + 4, b.y + 4);
          ctx.lineTo(b.x + b.w - 4, b.y + b.h - 4);
          ctx.moveTo(b.x + b.w - 4, b.y + 4);
          ctx.lineTo(b.x + 4, b.y + b.h - 4);
        }
      });
      const optLabel = card.options[i]!;
      const optSz = fitTo(optLabel, 14, b.w - 10);
      ink(ctx, isCorrect ? PINK : SAND, alpha, 1.7, () => {
        traceText(ctx, optLabel, b.x + b.w / 2, b.y + (b.h - optSz) / 2, optSz, 'center');
      });
    });

    const barY = padRect.y + padRect.h - 20;
    const barW = Math.min(220, padRect.w - 64);
    const barX = cx - barW / 2 - 10;
    const share = clamp(card.timeLeft / Math.max(0.1, card.timeLimit), 0, 1);
    const barColor = share > 0.5 ? NEON.lime : share > 0.25 ? NEON.yellow : NEON.red;
    ink(ctx, SAND, 0.28, 1, () => {
      ctx.rect(barX, barY - 4, barW, 8);
    }, false);
    if (share > 0) {
      ink(ctx, barColor, card.done ? 0.45 : 0.95, 4, () => {
        ctx.moveTo(barX + 2, barY);
        ctx.lineTo(barX + 2 + (barW - 4) * share, barY);
      });
    }
    const secLeft = String(Math.max(0, Math.ceil(card.timeLeft)));
    ink(ctx, barColor, card.done ? 0.5 : 0.95, 1.4, () => {
      traceText(ctx, secLeft, barX + barW + 8, barY - 5, 9, 'left');
    }, false);

    if (card.note) {
      const noteSz = fitTo(card.note, 8.5, padRect.w - 20);
      ink(ctx, card.noteColor, 0.95, 1.4, () => {
        traceText(ctx, card.note, cx, barY - 22, noteSz, 'center');
      });
    }
  }
}
