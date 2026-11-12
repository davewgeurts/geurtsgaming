/**
 * The keyboard, the mouse and the touch screen: what counts as held down, what goes to a question, and what
 * a click or tap is for. Node has EventTarget and Event, which is all the input needs to listen to.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Input, boxAt, type InputHost, type Surface } from '../src/game/input';

interface Rig { input: Input; keyboard: EventTarget; surface: Surface; log: string[]; host: InputHost & { wanted: string; commands: Set<string>; picks: boolean } }

function rig(mode: 'keys' | 'touch' = 'keys'): Rig {
  const log: string[] = [];
  const host = {
    wanted: '',
    commands: new Set<string>(),
    picks: false,
    wake: () => {},
    exit: () => log.push('exit'),
    wants(key: string) { return this.wanted.includes(key); },
    type: (key: string) => log.push(`type:${key}`),
    command(code: string) { log.push(`command:${code}`); return this.commands.has(code); },
    pick(x: number, y: number) { log.push(`pick:${x},${y}`); return this.picks; },
    touched: () => log.push('touched'),
    press: () => log.push('press'),
  };
  const keyboard = new EventTarget();
  const surface: Surface = Object.assign(new EventTarget(), {
    getBoundingClientRect: () => ({ left: 100, top: 50 }),
    setPointerCapture: () => {},
  });
  return { input: new Input(keyboard, surface, host, mode), keyboard, surface, log, host };
}

/** Send an event carrying these fields. Returns whether the page was kept from acting on it. */
function send(target: EventTarget, type: string, fields: Record<string, unknown>): boolean {
  const e = Object.assign(new Event(type, { cancelable: true }), fields);
  target.dispatchEvent(e);
  return e.defaultPrevented;
}
const key = (r: Rig, code: string, more: Record<string, unknown> = {}) => send(r.keyboard, 'keydown', { code, key: code, ...more });
const lift = (r: Rig, code: string, more: Record<string, unknown> = {}) => send(r.keyboard, 'keyup', { code, key: code, ...more });
const pointer = (r: Rig, type: string, x: number, y: number, more: Record<string, unknown> = {}) =>
  send(r.surface, type, { clientX: x, clientY: y, pointerId: 7, pointerType: 'touch', button: 0, ...more });

test('a point is in a box with a little slack round it, for fingers', () => {
  const boxes = [{ x: 0, y: 0, w: 50, h: 20 }, { x: 60, y: 0, w: 50, h: 20 }];
  assert.equal(boxAt(10, 10, boxes), 0);
  assert.equal(boxAt(63, 22, boxes), 1, 'two pixels under the second box still counts');
  assert.equal(boxAt(55, 10, boxes), null, 'the gap between them is nobody');
  assert.equal(boxAt(63, 26, boxes), null);
});

test('arrow keys and WASD steer, Space fires, and letting go stops', () => {
  const r = rig();
  assert.ok(key(r, 'ArrowRight'), 'the page does not scroll');
  key(r, 'KeyW');
  assert.deepEqual([r.input.across, r.input.down, r.input.firing], [1, -1, false]);
  key(r, 'KeyA');
  assert.equal(r.input.across, 0, 'left and right together cancel out');
  key(r, 'Space');
  assert.ok(r.input.firing);
  lift(r, 'ArrowRight');
  lift(r, 'Space');
  assert.deepEqual([r.input.across, r.input.firing], [-1, false]);
  send(r.keyboard, 'blur', {});
  assert.deepEqual([r.input.across, r.input.down], [0, 0], 'a window that loses the keyboard holds nothing');
});

test('Esc leaves, scroll keys are swallowed, shortcuts and other keys are left to the browser', () => {
  const r = rig();
  assert.ok(key(r, 'Escape'));
  assert.deepEqual(r.log, ['exit']);
  assert.ok(key(r, 'PageDown'));
  assert.ok(!key(r, 'KeyR', { metaKey: true }), 'Cmd+R still reloads');
  assert.ok(!key(r, 'ArrowLeft', { ctrlKey: true }));
  assert.ok(!key(r, 'Tab'));
  assert.equal(r.input.keys.size, 0);
  assert.deepEqual(r.log, ['exit']);
});

test('a key the question wants goes to the question, once, and is not a control', () => {
  const r = rig('touch');
  r.host.wanted = ' s3';
  assert.ok(send(r.keyboard, 'keydown', { code: 'KeyS', key: 's' }));
  assert.ok(send(r.keyboard, 'keydown', { code: 'KeyS', key: 's', repeat: true }), 'a held key is still kept from the page');
  assert.ok(send(r.keyboard, 'keydown', { code: 'Space', key: ' ' }));
  assert.deepEqual(r.log, ['type:s', 'type: ']);
  assert.equal(r.input.down, 0, 'S did not steer');
  assert.ok(!r.input.firing, 'Space did not fire');
  assert.equal(r.input.mode, 'keys', 'typing means there is a keyboard');
});

test('a command key is acted on and not held; any other game key is held', () => {
  const r = rig();
  r.host.commands.add('KeyP');
  key(r, 'KeyP');
  key(r, 'Space');
  key(r, 'Space', { repeat: true });
  assert.deepEqual(r.log, ['command:KeyP', 'command:Space'], 'a key that repeats is one press');
  assert.deepEqual([...r.input.keys], ['Space']);
});

test('Enter and Space on a focused button: Enter is the button\'s, Space is the game\'s', () => {
  const r = rig();
  const button = { tagName: 'BUTTON' };
  const down = Object.assign(new Event('keydown', { cancelable: true }), { code: 'Enter', key: 'Enter' });
  Object.defineProperty(down, 'target', { value: button });
  r.keyboard.dispatchEvent(down);
  assert.ok(!down.defaultPrevented, 'Enter still clicks the button');
  assert.deepEqual(r.log, []);
  const up = Object.assign(new Event('keyup', { cancelable: true }), { code: 'Space', key: ' ' });
  Object.defineProperty(up, 'target', { value: button });
  r.keyboard.dispatchEvent(up);
  assert.ok(up.defaultPrevented, 'Space does not');
});

test('a tap that picks something is not a steering touch', () => {
  const r = rig();
  r.host.picks = true;
  pointer(r, 'pointerdown', 300, 250);
  assert.deepEqual(r.log, ['pick:200,200'], 'the point is measured from the corner of the canvas');
  assert.ok(!r.input.touching);
  assert.equal(r.input.mode, 'touch');
});

test('a finger that picks nothing steers: the ship rides above it, and fires while it is down', () => {
  const r = rig();
  pointer(r, 'pointerdown', 300, 250);
  assert.deepEqual(r.log, ['pick:200,200', 'touched', 'press']);
  assert.ok(r.input.touching && r.input.firing);
  assert.deepEqual(r.input.touch, { x: 200, y: 136 });
  pointer(r, 'pointermove', 340, 250);
  assert.equal(r.input.touch.x, 240);
  pointer(r, 'pointermove', 500, 500, { pointerId: 8 });
  assert.equal(r.input.touch.x, 240, 'a second finger does not steer');
  pointer(r, 'pointerup', 340, 250, { pointerId: 8 });
  assert.ok(r.input.touching);
  pointer(r, 'pointerup', 340, 250);
  assert.ok(!r.input.touching && !r.input.firing);
});

test('a mouse clicks but does not steer, and only its main button plays', () => {
  const r = rig();
  pointer(r, 'pointerdown', 300, 250, { pointerType: 'mouse', button: 2 });
  assert.deepEqual(r.log, []);
  pointer(r, 'pointerdown', 300, 250, { pointerType: 'mouse' });
  assert.deepEqual(r.log, ['pick:200,200', 'press']);
  assert.ok(!r.input.touching);
  assert.equal(r.input.mode, 'keys', 'a mouse does not make it a touch screen');
});

test('dropping everything forgets the finger too, and a detached input hears nothing', () => {
  const r = rig();
  key(r, 'Space');
  pointer(r, 'pointerdown', 300, 250);
  r.input.drop();
  assert.ok(!r.input.firing && !r.input.touching);
  r.input.detach();
  r.log.length = 0;
  key(r, 'Space');
  pointer(r, 'pointerdown', 300, 250);
  assert.deepEqual(r.log, []);
  assert.ok(!r.input.firing);
});
