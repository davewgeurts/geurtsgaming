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
import { NEON, SAND, clamp, strokeInk as ink } from './core';
import { fitTo, traceText } from './font';

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
    if (clearAutoFire) {
      this.autoFireLatch = false;
    }
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
      gameOver?: boolean;
      wingmen?: ReadonlyArray<{
        seat: CoopSeatIndex;
        connected: boolean;
        alive: boolean;
        hull: number;
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
        const wColor = COOP_SEAT_COLORS[w.seat] ?? SAND;
        const wTag = !w.connected ? `P${w.seat + 1} WAIT` : !w.alive ? `P${w.seat + 1} OUT` : `P${w.seat + 1} ${w.hull}HP`;
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

    // Trackpad frame + subtle cyber grid
    ctx.fillStyle = 'rgba(7, 17, 54, 0.72)';
    ctx.fillRect(padRect.x, padRect.y, padRect.w, padRect.h);
    ink(ctx, seatColor, this.activePointerId !== null ? 0.85 : 0.42, 1.5, () => {
      ctx.rect(padRect.x, padRect.y, padRect.w, padRect.h);
    });

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
}
