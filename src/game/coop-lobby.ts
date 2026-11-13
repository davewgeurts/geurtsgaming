/**
 * Co-op 4-Seat Squad Lobby state machine & accessible neon modal UI.
 *
 * - Supports Host (POST `/relay/room` -> `ABC-DEF` + crisp SVG QR code + Copy Invite Link + Kick + Launch Squad)
 *   and Guest (`?j=ABCDEF` URL auto-join or typed 6-char code + Callsign cycle + Ready toggle + Leave).
 * - Persists active lobby session metadata (`gg_coop_active`) in `sessionStorage` ONLY so a mid-lobby
 *   page refresh or phone wake automatically re-opens the lobby and reclaims the player's held seat,
 *   while deliberate Leave / `refused` / `room-closed` clears it immediately.
 * - Uses polite, kid-friendly wording ("removed" rather than "blocked") and renders zero untrusted free-text.
 */
import {
  CoopClient,
  buildCoopInviteUrl,
  createCoopRoom,
  ensureCoopCallsign,
  nextAvailableCallsign,
  type CoopConnectOptions,
  type StorageLike,
} from './coop-client';
import {
  COOP_SEAT_COLORS,
  formatCoopRoomCode,
  isValidCoopRoomCode,
  normalizeCoopRoomCode,
  type CoopHostSeatIndex,
  type CoopLobbyState,
  type CoopPublicSeat,
  type CoopRefusalReason,
  type CoopRole,
  type CoopRoomClosedReason,
  type CoopSeatIndex,
} from './coop-types';
import { renderQrSvg } from './qr';
import { Sound } from './sound';

const ACTIVE_SESSION_KEY = 'gg_coop_active';

export type CoopLobbyScreen = 'choose' | 'connecting' | 'lobby' | 'launched';

export interface ActiveCoopSession {
  code: string;
  role: CoopRole;
  callsign: string;
}

export interface CoopLobbySnapshot {
  screen: CoopLobbyScreen;
  code: string;
  formattedCode: string;
  inviteUrl: string;
  role: CoopRole;
  mySeat: CoopHostSeatIndex;
  callsign: string;
  tvMode: boolean;
  locked: boolean;
  connected: boolean;
  hostConnected: boolean;
  hostGraceMs: number | null;
  seats: CoopPublicSeat[];
  notice: string;
  error: string;
  canStart: boolean;
}

function defaultSessionStorage(): StorageLike | null {
  try {
    return typeof sessionStorage !== 'undefined' ? sessionStorage : null;
  } catch {
    return null;
  }
}

export function saveActiveCoopSession(
  session: ActiveCoopSession,
  storage: StorageLike | null = defaultSessionStorage(),
): void {
  try {
    storage?.setItem(ACTIVE_SESSION_KEY, JSON.stringify(session));
  } catch {
    /* ignore */
  }
}

export function loadActiveCoopSession(
  storage: StorageLike | null = defaultSessionStorage(),
): ActiveCoopSession | null {
  try {
    const raw = storage?.getItem(ACTIVE_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ActiveCoopSession>;
    if (
      parsed &&
      typeof parsed.code === 'string' &&
      isValidCoopRoomCode(parsed.code) &&
      (parsed.role === 'host' || parsed.role === 'guest')
    ) {
      return {
        code: normalizeCoopRoomCode(parsed.code),
        role: parsed.role,
        callsign: ensureCoopCallsign(parsed.callsign),
      };
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function clearActiveCoopSession(storage: StorageLike | null = defaultSessionStorage()): void {
  try {
    storage?.removeItem(ACTIVE_SESSION_KEY);
  } catch {
    /* ignore */
  }
}

export function describeRefusalReason(reason: CoopRefusalReason | 'invalid-code'): string {
  switch (reason) {
    case 'not-found':
      return 'No squad room found with that code. Check the 6 characters and try again.';
    case 'expired':
      return 'That squad room has expired. Ask the host to open a new room.';
    case 'started':
      return 'That squad has already launched into flight.';
    case 'full':
      return 'That squad is already full (4 of 4 pilots).';
    case 'kicked':
      return 'You were removed from the squad lobby by the host.';
    case 'already-hosted':
      return 'That room already has an active host.';
    case 'replaced':
      return 'This squad is open in another tab or on another device.';
    case 'invalid-code':
      return 'Enter a valid 6-character code (A–Z and 2–9; no 0, O, 1, I, or L).';
  }
}

export function describeRoomClosedReason(reason: CoopRoomClosedReason): string {
  switch (reason) {
    case 'host-left':
      return 'The squad host left, so the room closed.';
    case 'expired':
      return 'The squad room timed out and closed.';
    case 'closed':
      return 'The squad room closed.';
  }
}

export interface CoopLobbyControllerOptions {
  initialCallsign?: string;
  storage?: StorageLike | null;
  createRoomFn?: () => Promise<{ code: string; formattedCode: string }>;
  clientFactory?: (opts: CoopConnectOptions) => CoopClient;
  inviteLocation?: Location;
  onJoinChime?: () => void;
  onLaunchChime?: () => void;
  onCoopActiveChange?: (active: boolean) => void;
  onSquadLaunched?: (client: CoopClient, seats: CoopPublicSeat[]) => void;
}

/**
 * Pure, framework-free state machine driving the Co-op Lobby (unit-testable in Node without a DOM).
 */
export class CoopLobbyController {
  private screen: CoopLobbyScreen = 'choose';
  private code = '';
  private role: CoopRole = 'guest';
  private mySeat: CoopHostSeatIndex = -1;
  private callsign: string;
  private tvMode = false;
  private locked = false;
  private connected = false;
  private hostConnected = true;
  private hostGraceMs: number | null = null;
  private seats: CoopPublicSeat[] = [];
  private notice = '';
  private error = '';
  private welcomedOnce = false;

  private client: CoopClient | null = null;
  private readonly storage: StorageLike | null;
  private readonly createRoomFn: () => Promise<{ code: string; formattedCode: string }>;
  private readonly clientFactory: (opts: CoopConnectOptions) => CoopClient;
  private readonly opts: CoopLobbyControllerOptions;
  private readonly listeners = new Set<(snap: CoopLobbySnapshot) => void>();

  constructor(opts: CoopLobbyControllerOptions = {}) {
    this.opts = opts;
    this.callsign = ensureCoopCallsign(opts.initialCallsign);
    this.storage = opts.storage === undefined ? defaultSessionStorage() : opts.storage;
    this.createRoomFn = opts.createRoomFn ?? (() => createCoopRoom());
    this.clientFactory = opts.clientFactory ?? ((connectOpts) => new CoopClient(connectOpts));
  }

  get activeClient(): CoopClient | null {
    return this.client;
  }

  snapshot(): CoopLobbySnapshot {
    const formattedCode = this.code ? formatCoopRoomCode(this.code) : '';
    const inviteUrl = this.code ? buildCoopInviteUrl(this.code, this.opts.inviteLocation) : '';
    const canStart =
      this.role === 'host' &&
      !this.locked &&
      this.connected &&
      this.seats.filter((s) => s.connected).length >= 2;
    return {
      screen: this.screen,
      code: this.code,
      formattedCode,
      inviteUrl,
      role: this.role,
      mySeat: this.mySeat,
      callsign: this.callsign,
      tvMode: this.tvMode,
      locked: this.locked,
      connected: this.connected,
      hostConnected: this.hostConnected,
      hostGraceMs: this.hostGraceMs,
      seats: this.seats.map((s) => ({ ...s })),
      notice: this.notice,
      error: this.error,
      canStart,
    };
  }

  subscribe(fn: (snap: CoopLobbySnapshot) => void): () => void {
    this.listeners.add(fn);
    fn(this.snapshot());
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    const snap = this.snapshot();
    for (const fn of this.listeners) fn(snap);
  }

  resetToChoose(errorMsg = '', noticeMsg = ''): void {
    this.teardownClient(false);
    clearActiveCoopSession(this.storage);
    this.screen = 'choose';
    this.code = '';
    this.mySeat = -1;
    this.locked = false;
    this.connected = false;
    this.hostConnected = true;
    this.hostGraceMs = null;
    this.seats = [];
    this.welcomedOnce = false;
    this.error = errorMsg;
    this.notice = noticeMsg;
    this.opts.onCoopActiveChange?.(false);
    this.emit();
  }

  async hostNewRoom(tvMode = false): Promise<void> {
    if (this.screen === 'connecting') return;
    this.teardownClient(false);
    this.screen = 'connecting';
    this.role = 'host';
    this.tvMode = tvMode;
    this.error = '';
    this.notice = 'Opening squad frequency...';
    this.opts.onCoopActiveChange?.(true);
    this.emit();

    try {
      const created = await this.createRoomFn();
      this.openRoomSocket(created.code, 'host', tvMode);
    } catch (err) {
      this.screen = 'choose';
      this.notice = '';
      this.error = err instanceof Error ? err.message : 'Could not create squad room. Try again.';
      this.opts.onCoopActiveChange?.(false);
      this.emit();
    }
  }

  joinRoomByCode(rawCode: string, role: CoopRole = 'guest'): boolean {
    if (!isValidCoopRoomCode(rawCode)) {
      this.error = describeRefusalReason('invalid-code');
      this.emit();
      return false;
    }
    const clean = normalizeCoopRoomCode(rawCode);
    this.teardownClient(false);
    this.screen = 'connecting';
    this.role = role;
    this.code = clean;
    this.error = '';
    this.notice = `Connecting to squad ${formatCoopRoomCode(clean)}...`;
    this.opts.onCoopActiveChange?.(true);
    this.emit();
    this.openRoomSocket(clean, role, false);
    return true;
  }

  /** Surface a launch, chunk-load, or protocol-version error inside the Hangar modal. */
  reportError(message: string): void {
    this.error = message;
    this.emit();
  }

  private openRoomSocket(code: string, role: CoopRole, tvMode: boolean): void {
    this.code = normalizeCoopRoomCode(code);
    this.welcomedOnce = false;

    const client = this.clientFactory({
      code: this.code,
      role,
      callsign: this.callsign,
      tvMode,
      storage: this.storage,
      onConnectionChange: (isConn) => {
        this.connected = isConn;
        if (!isConn && this.welcomedOnce && (this.screen === 'lobby' || this.screen === 'launched')) {
          this.notice = 'Signal interrupted — reconnecting to your seat...';
        } else if (isConn && this.welcomedOnce && this.hostConnected) {
          this.notice = '';
        }
        this.emit();
      },
      onWelcome: (msg) => {
        this.welcomedOnce = true;
        this.role = msg.role;
        this.mySeat = msg.seat;
        this.tvMode = msg.tvMode;
        this.locked = msg.locked;
        this.seats = msg.seats;
        const mine = msg.seats.find((s) => s.seat === msg.seat);
        if (mine) this.callsign = mine.callsign;
        this.error = '';
        this.notice = '';
        saveActiveCoopSession(
          { code: this.code, role: this.role, callsign: this.callsign },
          this.storage,
        );
        // Returning player rejoining an already-started game learns it via `welcome.locked === true`!
        this.screen = msg.locked ? 'launched' : 'lobby';
        this.emit();
        if (msg.locked) {
          this.opts.onSquadLaunched?.(client, msg.seats);
        }
      },
      onLobby: (state: CoopLobbyState) => {
        const prevCount = this.seats.length;
        this.tvMode = state.tvMode;
        this.locked = state.locked;
        this.hostConnected = state.hostConnected;
        if (state.hostConnected) this.hostGraceMs = null;
        this.seats = state.seats;
        const mine = state.seats.find((s) => s.seat === this.mySeat);
        if (mine) {
          this.callsign = mine.callsign;
          saveActiveCoopSession(
            { code: this.code, role: this.role, callsign: this.callsign },
            this.storage,
          );
        }
        if (this.welcomedOnce && state.seats.length > prevCount) {
          this.opts.onJoinChime?.();
        }
        if (state.locked && this.screen === 'lobby') {
          this.screen = 'launched';
        }
        this.emit();
      },
      onStarted: (seats) => {
        this.locked = true;
        this.seats = seats;
        this.screen = 'launched';
        this.notice = '';
        this.opts.onLaunchChime?.();
        this.emit();
        this.opts.onSquadLaunched?.(client, seats);
      },
      onHostReconnecting: (graceMs) => {
        this.hostConnected = false;
        this.hostGraceMs = graceMs;
        this.notice = `Host connection dropped — holding squad open (${Math.ceil(graceMs / 1000)}s)...`;
        this.emit();
      },
      onHostResumed: () => {
        this.hostConnected = true;
        this.hostGraceMs = null;
        this.notice = '';
        this.emit();
      },
      onRefused: (reason) => {
        this.client = null;
        this.resetToChoose(describeRefusalReason(reason));
      },
      onRoomClosed: (reason) => {
        this.client = null;
        this.resetToChoose('', describeRoomClosedReason(reason));
      },
      onConnectionError: (msg) => {
        this.client = null;
        this.resetToChoose(msg);
      },
    });

    this.client = client;
    client.connect();
  }

  toggleReady(): void {
    if (!this.client || this.locked || this.mySeat < 0) return;
    const mine = this.seats.find((s) => s.seat === this.mySeat);
    if (!mine || mine.isHost) return;
    this.client.setReady(!mine.ready);
  }

  cycleMyCallsign(): void {
    if (!this.client || this.locked || this.mySeat < 0) return;
    const next = nextAvailableCallsign(
      this.callsign,
      this.seats.map((s) => s.callsign),
    );
    this.callsign = next;
    this.client.setCallsign(next);
  }

  kickSeat(seat: CoopSeatIndex): void {
    if (!this.client || this.role !== 'host' || this.locked) return;
    this.client.kickSeat(seat);
  }

  launchSquad(): void {
    if (!this.client || this.role !== 'host' || this.locked) return;
    if (this.seats.filter((s) => s.connected).length < 2) return;
    this.client.startSquad();
  }

  /** Explicit Leave button: frees seat immediately on relay and clears `sessionStorage` state. */
  leaveRoom(): void {
    this.teardownClient(true);
    clearActiveCoopSession(this.storage);
    this.opts.onCoopActiveChange?.(false);
    this.resetToChoose();
  }

  /** Unmount cleanup without forfeiting 30s refresh grace in `sessionStorage`. */
  dispose(): void {
    this.teardownClient(false);
  }

  private teardownClient(sendExplicitLeave: boolean): void {
    const c = this.client;
    this.client = null;
    if (!c) return;
    if (sendExplicitLeave) c.leave();
    else c.dispose();
  }
}

export interface CoopLobbyModalOptions {
  root: HTMLElement;
  controller?: CoopLobbyController;
  initialCallsign?: string;
  onCloseModal: () => void;
  onCoopActiveChange?: (active: boolean) => void;
  onSquadLaunched?: (client: CoopClient, seats: CoopPublicSeat[]) => void;
}

/**
 * Accessible DOM binding for the Co-op Lobby modal mounted in `HeroGame.astro`.
 */
export class CoopLobbyModal {
  readonly controller: CoopLobbyController;
  private readonly root: HTMLElement;
  private readonly sound = new Sound();
  private readonly onCloseModal: () => void;
  private qrExpanded = true;
  private copiedUntil = 0;
  private draftJoinCode = '';
  private lastQrUrl = '';
  private lastQrSvg = '';
  private lastRenderedError: string | null = null;
  private lastRenderedStatus: string | null = null;
  private lastRenderedStatusStyle: 'info' | 'warn' | 'connecting' = 'info';
  private unsubscribe: (() => void) | null = null;

  constructor(opts: CoopLobbyModalOptions) {
    this.root = opts.root;
    this.onCloseModal = opts.onCloseModal;
    this.controller =
      opts.controller ??
      new CoopLobbyController({
        initialCallsign: opts.initialCallsign,
        onJoinChime: () => this.sound.play('free'),
        onLaunchChime: () => this.sound.play('start'),
        onCoopActiveChange: opts.onCoopActiveChange,
        onSquadLaunched: opts.onSquadLaunched,
      });
    this.bindEvents();
    this.unsubscribe = this.controller.subscribe((snap) => this.render(snap));
  }

  openChoose(): void {
    this.sound.unlock();
    if (this.controller.snapshot().screen === 'choose') {
      this.render(this.controller.snapshot());
    }
  }

  openWithJoinCode(code: string, role: CoopRole = 'guest'): void {
    this.sound.unlock();
    this.draftJoinCode = formatCoopRoomCode(code);
    this.controller.joinRoomByCode(code, role);
  }

  destroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.controller.dispose();
    this.sound.dispose();
  }

  private bindEvents(): void {
    this.root.addEventListener('click', (ev) => {
      const target = (ev.target as HTMLElement | null)?.closest<HTMLElement>('[data-coop-action]');
      if (!target) return;
      this.sound.unlock();
      const action = target.dataset.coopAction;

      if (action === 'close') {
        const snap = this.controller.snapshot();
        if (snap.screen !== 'choose') {
          this.controller.leaveRoom();
        }
        this.onCloseModal();
        return;
      }
      if (action === 'host') {
        void this.controller.hostNewRoom(false);
        return;
      }
      if (action === 'leave') {
        this.controller.leaveRoom();
        this.onCloseModal();
        return;
      }
      if (action === 'ready') {
        this.controller.toggleReady();
        return;
      }
      if (action === 'callsign') {
        this.controller.cycleMyCallsign();
        return;
      }
      if (action === 'kick') {
        const seatNum = Number(target.dataset.seat);
        if (seatNum === 0 || seatNum === 1 || seatNum === 2 || seatNum === 3) {
          this.controller.kickSeat(seatNum);
        }
        return;
      }
      if (action === 'start') {
        this.controller.launchSquad();
        return;
      }
      if (action === 'toggle-qr') {
        this.qrExpanded = !this.qrExpanded;
        this.render(this.controller.snapshot());
        return;
      }
      if (action === 'copy-link') {
        const url = this.controller.snapshot().inviteUrl;
        if (url && navigator.clipboard?.writeText) {
          void navigator.clipboard.writeText(url).then(() => {
            this.copiedUntil = Date.now() + 2_000;
            this.render(this.controller.snapshot());
            setTimeout(() => this.render(this.controller.snapshot()), 2_050);
          });
        }
      }
    });

    this.root.addEventListener('input', (ev) => {
      const input = ev.target as HTMLInputElement | null;
      if (!input || input.name !== 'coop-code') return;
      const clean = normalizeCoopRoomCode(input.value);
      const formatted = clean.length > 3 ? `${clean.slice(0, 3)}-${clean.slice(3)}` : clean;
      this.draftJoinCode = formatted;
      if (input.value !== formatted) input.value = formatted;
    });

    this.root.addEventListener('submit', (ev) => {
      const form = ev.target as HTMLFormElement | null;
      if (!form || !form.matches('[data-coop-join-form]')) return;
      ev.preventDefault();
      this.sound.unlock();
      const input = form.querySelector<HTMLInputElement>('input[name="coop-code"]');
      const code = input ? input.value : this.draftJoinCode;
      this.controller.joinRoomByCode(code, 'guest');
    });
  }

  private ensurePanelSlots(panel: HTMLElement): {
    headSlot: HTMLElement;
    alertSlot: HTMLElement;
    statusSlot: HTMLElement;
    bodySlot: HTMLElement;
  } {
    if (!panel.hasAttribute('tabindex')) {
      panel.setAttribute('tabindex', '-1');
    }
    let headSlot = panel.querySelector<HTMLElement>('[data-coop-head-slot]');
    let alertSlot = panel.querySelector<HTMLElement>('[data-coop-alert-slot]');
    let statusSlot = panel.querySelector<HTMLElement>('[data-coop-status-slot]');
    let bodySlot = panel.querySelector<HTMLElement>('[data-coop-body-slot]');
    if (!headSlot || !alertSlot || !statusSlot || !bodySlot) {
      panel.innerHTML = `
        <div style="display:contents" data-coop-head-slot></div>
        <div style="display:contents" data-coop-alert-slot></div>
        <div style="display:contents" data-coop-status-slot></div>
        <div style="display:contents" data-coop-body-slot></div>
      `;
      this.lastRenderedError = null;
      this.lastRenderedStatus = null;
      headSlot = panel.querySelector<HTMLElement>('[data-coop-head-slot]')!;
      alertSlot = panel.querySelector<HTMLElement>('[data-coop-alert-slot]')!;
      statusSlot = panel.querySelector<HTMLElement>('[data-coop-status-slot]')!;
      bodySlot = panel.querySelector<HTMLElement>('[data-coop-body-slot]')!;
    }
    return { headSlot, alertSlot, statusSlot, bodySlot };
  }

  private render(snap: CoopLobbySnapshot): void {
    const panel = this.root.querySelector<HTMLElement>('[data-coop-panel]');
    if (!panel) return;

    // Remember whichever interactive control inside `panel` currently holds keyboard focus so
    // lobby updates (ready toggles, new joins, callsign cycles) never drop focus onto `<body>`.
    const activeEl =
      typeof document !== 'undefined' &&
      document.activeElement instanceof HTMLElement &&
      panel.contains(document.activeElement)
        ? document.activeElement
        : null;
    const wasTypingCode = activeEl instanceof HTMLInputElement && activeEl.name === 'coop-code';
    const codeSelStart = wasTypingCode ? activeEl.selectionStart : null;
    const codeSelEnd = wasTypingCode ? activeEl.selectionEnd : null;
    const wasJoinBtn = Boolean(activeEl?.hasAttribute('data-coop-join-btn'));
    const focusedAction = activeEl?.dataset.coopAction ?? null;
    const focusedSeat = activeEl?.dataset.seat ?? null;
    const focusedSeatCard = activeEl?.dataset.coopSeat ?? null;
    const hadFocusInPanel = Boolean(activeEl);

    const { headSlot, alertSlot, statusSlot, bodySlot } = this.ensurePanelSlots(panel);

    let headHtml = '';
    let bodyHtml = '';
    const errorText = snap.error;
    let statusText = snap.notice;
    let statusStyle: 'info' | 'warn' | 'connecting' = 'info';

    if (snap.screen === 'choose') {
      headHtml = `
        <div class="coop-head">
          <div>
            <p class="coop-eyebrow">2–4 Pilots · Same Wi-Fi or Anywhere</p>
            <h2 id="coop-modal-title" class="coop-title">Fly With Friends</h2>
          </div>
          <button type="button" class="coop-icon-btn" data-coop-action="close" aria-label="Close squad modal">✕</button>
        </div>
      `;
      bodyHtml = this.renderChooseBodyHtml();
      statusStyle = 'info';
    } else if (snap.screen === 'connecting') {
      headHtml = `
        <div class="coop-head">
          <h2 id="coop-modal-title" class="coop-title">Squad Comms</h2>
          <button type="button" class="coop-icon-btn" data-coop-action="close" aria-label="Cancel and close">✕</button>
        </div>
      `;
      statusText = snap.notice || 'Connecting...';
      statusStyle = 'connecting';
      bodyHtml = '';
    } else {
      headHtml = `
        <div class="coop-head">
          <div>
            <p class="coop-eyebrow">${snap.locked ? 'Squad Locked · Mission Active' : 'Squad Hangar · Up to 4 Pilots'}</p>
            <h2 id="coop-modal-title" class="coop-title">Room <span class="coop-code-badge" data-coop-room-code>${escapeHtml(snap.formattedCode)}</span></h2>
          </div>
          <button type="button" class="coop-btn coop-btn-ghost" data-coop-action="leave" data-coop-leave>Leave</button>
        </div>
      `;
      bodyHtml = this.renderHangarBodyHtml(snap);
      statusStyle = 'warn';
    }

    // Only re-insert `role="alert"` / `role="status"` live regions when their text actually changes,
    // preventing screen readers from repeating unchanged banners on every lobby broadcast.
    if (errorText !== this.lastRenderedError) {
      this.lastRenderedError = errorText;
      alertSlot.innerHTML = errorText
        ? `<p class="coop-alert coop-alert-err" role="alert">${escapeHtml(errorText)}</p>`
        : '';
    }
    if (
      statusText !== this.lastRenderedStatus ||
      (statusText !== '' && statusStyle !== this.lastRenderedStatusStyle)
    ) {
      this.lastRenderedStatus = statusText;
      this.lastRenderedStatusStyle = statusStyle;
      if (!statusText) {
        statusSlot.innerHTML = '';
      } else if (statusStyle === 'connecting') {
        statusSlot.innerHTML = `<p class="coop-status-banner" role="status">${escapeHtml(statusText)}</p>`;
      } else if (statusStyle === 'warn') {
        statusSlot.innerHTML = `<p class="coop-alert coop-alert-warn" data-coop-banner role="status">${escapeHtml(statusText)}</p>`;
      } else {
        statusSlot.innerHTML = `<p class="coop-alert coop-alert-info" role="status">${escapeHtml(statusText)}</p>`;
      }
    }

    headSlot.innerHTML = headHtml;
    bodySlot.innerHTML = bodyHtml;

    if (hadFocusInPanel) {
      this.restoreFocus(panel, {
        wasTypingCode,
        codeSelStart,
        codeSelEnd,
        wasJoinBtn,
        focusedAction,
        focusedSeat,
        focusedSeatCard,
      });
    }
  }

  private restoreFocus(
    panel: HTMLElement,
    saved: {
      wasTypingCode: boolean;
      codeSelStart: number | null;
      codeSelEnd: number | null;
      wasJoinBtn: boolean;
      focusedAction: string | null;
      focusedSeat: string | null;
      focusedSeatCard: string | null;
    },
  ): void {
    if (saved.wasTypingCode) {
      const nextInput = panel.querySelector<HTMLInputElement>('input[name="coop-code"]');
      if (nextInput) {
        nextInput.focus({ preventScroll: true });
        if (saved.codeSelStart !== null && saved.codeSelEnd !== null) {
          try {
            nextInput.setSelectionRange(saved.codeSelStart, saved.codeSelEnd);
          } catch {
            /* ignore */
          }
        }
        return;
      }
    }

    const nextTarget = resolveLobbyFocusTarget(panel, saved);
    nextTarget?.focus({ preventScroll: true });
  }

  private renderChooseBodyHtml(): string {
    return `
      <div class="coop-choose-grid">
        <button type="button" class="coop-primary-card" data-coop-action="host" data-coop-host-btn>
          <span class="coop-card-kicker">Open a Hangar</span>
          <span class="coop-card-heading">Host a Squad</span>
          <span class="coop-card-sub">Get a 6-character room code &amp; QR code for up to 3 wingmen.</span>
        </button>
        <form class="coop-join-card" data-coop-join-form novalidate>
          <label class="coop-card-kicker" for="coop-code-input">Have a Room Code?</label>
          <div class="coop-join-row">
            <input
              id="coop-code-input"
              class="coop-code-input"
              name="coop-code"
              type="text"
              inputmode="text"
              autocomplete="off"
              autocapitalize="characters"
              spellcheck="false"
              maxlength="7"
              placeholder="ABC-DEF"
              value="${escapeHtml(this.draftJoinCode)}"
              aria-label="6-character squad room code"
            />
            <button type="submit" class="coop-btn coop-btn-accent" data-coop-join-btn>Join</button>
          </div>
          <span class="coop-card-sub">Scan the host's QR code with your phone camera, or type the 6 characters above.</span>
        </form>
      </div>
    `;
  }

  private renderHangarBodyHtml(snap: CoopLobbySnapshot): string {
    if (snap.inviteUrl && snap.inviteUrl !== this.lastQrUrl) {
      this.lastQrUrl = snap.inviteUrl;
      this.lastQrSvg = renderQrSvg(snap.inviteUrl, {
        label: `Scan QR code to join squad ${snap.formattedCode}`,
      });
    }
    const copied = Date.now() < this.copiedUntil;
    const mySeatObj = snap.seats.find((s) => s.seat === snap.mySeat) ?? null;

    const seatCards: string[] = [];
    for (let s = 0 as CoopSeatIndex; s < 4; s = (s + 1) as CoopSeatIndex) {
      const info = snap.seats.find((item) => item.seat === s);
      const color = COOP_SEAT_COLORS[s];
      const isMe = s === snap.mySeat;
      if (info) {
        const badge = !info.connected
          ? 'RECONNECTING'
          : info.isHost
            ? 'HOST'
            : info.ready
              ? 'READY'
              : 'STANDBY';
        const badgeClass = !info.connected
          ? 'warn'
          : info.isHost || info.ready
            ? 'ok'
            : 'idle';
        seatCards.push(`
          <div class="coop-seat occupied ${isMe ? 'me' : ''}" style="--seat-color:${color}" data-coop-seat="${s}">
            <div class="coop-seat-main">
              <span class="coop-seat-num">P${s + 1}</span>
              <svg class="coop-seat-ship" viewBox="-16 -18 32 36" width="22" height="24" aria-hidden="true">
                <path d="M0 -15 L4 -4 L13 10 L5 7 L3 12 L-3 12 L-5 7 L-13 10 L-4 -4 Z" />
              </svg>
              <span class="coop-seat-callsign">${escapeHtml(info.callsign)}${isMe ? ' (YOU)' : ''}</span>
            </div>
            <div class="coop-seat-actions">
              <span class="coop-pill coop-pill-${badgeClass}">${badge}</span>
              ${
                isMe && !snap.locked
                  ? `<button type="button" class="coop-mini-btn" data-coop-action="callsign" title="Cycle callsign">Callsign ↻</button>`
                  : ''
              }
              ${
                snap.role === 'host' && !info.isHost && !snap.locked
                  ? `<button type="button" class="coop-mini-btn coop-kick-btn" data-coop-action="kick" data-seat="${s}" aria-label="Remove ${escapeHtml(info.callsign)}">× Remove</button>`
                  : ''
              }
            </div>
          </div>
        `);
      } else {
        seatCards.push(`
          <div class="coop-seat empty" style="--seat-color:${color}" data-coop-seat="${s}" tabindex="-1">
            <div class="coop-seat-main">
              <span class="coop-seat-num">P${s + 1}</span>
              <span class="coop-seat-empty">${snap.locked ? 'Empty Wing' : 'Open Wingman Slot'}</span>
            </div>
          </div>
        `);
      }
    }

    const readyGuests = snap.seats.filter((s) => !s.isHost && s.ready && s.connected).length;
    const totalGuests = snap.seats.filter((s) => !s.isHost && s.connected).length;
    const hostHint =
      totalGuests === 0
        ? 'Share the QR or room code to bring 1–3 wingmen aboard.'
        : readyGuests === totalGuests
          ? 'All wingmen ready for launch!'
          : `${readyGuests} of ${totalGuests} wingmen marked Ready.`;

    return `
      ${
        !snap.locked
          ? `
        <div class="coop-invite-bar">
          <div class="coop-invite-btns">
            <button type="button" class="coop-btn" data-coop-action="copy-link" data-coop-copy-link>
              ${copied ? 'Invite Link Copied ✓' : 'Copy Invite Link'}
            </button>
            <button type="button" class="coop-btn coop-btn-ghost" data-coop-action="toggle-qr">
              ${this.qrExpanded ? 'Hide QR' : 'Show QR'}
            </button>
          </div>
          ${
            this.qrExpanded && this.lastQrSvg
              ? `<div class="coop-qr-wrap" data-coop-qr>${this.lastQrSvg}<span class="coop-qr-caption">Point a phone camera here to join</span></div>`
              : ''
          }
        </div>
      `
          : `
        <div class="coop-launched-banner" data-coop-launched>
          <strong>Squad Launched!</strong> Room ${escapeHtml(snap.formattedCode)} is locked to your ${snap.seats.length}-pilot flight.
        </div>
      `
      }

      <div class="coop-seats-list" role="list" aria-label="Squad pilot seats">
        ${seatCards.join('')}
      </div>

      ${
        !snap.locked
          ? `
        <div class="coop-footer">
          ${
            snap.role === 'host'
              ? `
                <p class="coop-footer-hint">${escapeHtml(hostHint)}</p>
                <button
                  type="button"
                  class="coop-btn coop-btn-launch"
                  data-coop-action="start"
                  data-coop-start-btn
                  ${snap.canStart ? '' : 'disabled'}
                >
                  Launch Squad (${snap.seats.filter((s) => s.connected).length}/4)
                </button>
              `
              : `
                <p class="coop-footer-hint">Tap Ready when you are set — the host launches the squad.</p>
                <button
                  type="button"
                  class="coop-btn ${mySeatObj?.ready ? 'coop-btn-ready-on' : 'coop-btn-accent'}"
                  data-coop-action="ready"
                  data-coop-ready-btn
                  aria-pressed="${Boolean(mySeatObj?.ready)}"
                >
                  ${mySeatObj?.ready ? 'Ready ✓ (Tap to Stand Down)' : 'Ready Up'}
                </button>
              `
          }
        </div>
      `
          : ''
      }
    `;
  }
}

export interface SavedLobbyFocus {
  wasJoinBtn: boolean;
  focusedAction: string | null;
  focusedSeat: string | null;
  focusedSeatCard?: string | null;
}

/**
 * Pick which element inside `panel` should receive keyboard focus after a lobby re-render.
 *
 * Safety invariant: NEVER fall back to `kick` (removing another guest) or `leave` (closing the room)
 * when a previously focused control disappears. Queries run one selector at a time in priority order
 * rather than a comma-separated list (which `querySelector` evaluates in DOM tree order).
 */
export function resolveLobbyFocusTarget(
  panel: HTMLElement,
  saved: SavedLobbyFocus,
): HTMLElement | null {
  let nextTarget: HTMLElement | null = null;
  if (saved.wasJoinBtn) {
    nextTarget = panel.querySelector<HTMLElement>('[data-coop-join-btn]:not([disabled])');
  } else if (saved.focusedAction === 'kick') {
    if (saved.focusedSeat !== null) {
      nextTarget = panel.querySelector<HTMLElement>(
        `[data-coop-action="kick"][data-seat="${saved.focusedSeat}"]:not([disabled])`,
      );
      if (!nextTarget) {
        nextTarget = panel.querySelector<HTMLElement>(
          `[data-coop-seat="${saved.focusedSeat}"][tabindex]`,
        );
      }
    }
  } else if (saved.focusedAction) {
    if (saved.focusedSeat !== null) {
      nextTarget = panel.querySelector<HTMLElement>(
        `[data-coop-action="${saved.focusedAction}"][data-seat="${saved.focusedSeat}"]:not([disabled])`,
      );
    }
    if (!nextTarget) {
      nextTarget = panel.querySelector<HTMLElement>(
        `[data-coop-action="${saved.focusedAction}"]:not([disabled])`,
      );
    }
  } else if (saved.focusedSeatCard !== undefined && saved.focusedSeatCard !== null) {
    nextTarget = panel.querySelector<HTMLElement>(
      `[data-coop-seat="${saved.focusedSeatCard}"][tabindex]`,
    );
  }

  if (!nextTarget) {
    nextTarget =
      panel.querySelector<HTMLElement>('[data-coop-copy-link]:not([disabled])') ??
      panel.querySelector<HTMLElement>('[data-coop-ready-btn]:not([disabled])') ??
      panel.querySelector<HTMLElement>('input[name="coop-code"]:not([disabled])') ??
      panel.querySelector<HTMLElement>('[data-coop-host-btn]:not([disabled])') ??
      panel;
  }
  return nextTarget;
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
