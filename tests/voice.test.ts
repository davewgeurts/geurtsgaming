/**
 * Speech: which lines get said, in whose voice, and who may talk over whom. The browser's speech engine is
 * stood in for by one that writes down what it is asked to say. (Nothing here can tell how it sounds.)
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BRIEFING, TAUNTS } from '../src/game/lines';
import { PILOTS, PILOT_BY_ID, PILOT_IDS } from '../src/game/loadout';
import { Voice, castVoices, pickPilotVoice, spoken, type SpeechEngine, type UtteranceLike, type VoiceLike } from '../src/game/voice';

const voice = (name: string, lang = 'en-GB', localService = true, isDefault = false): VoiceLike => ({ name, lang, localService, default: isDefault });
const MAC = [voice('Daniel', 'en-GB', true, true), voice('Samantha', 'en-US'), voice('Karen', 'en-AU'), voice('Fred', 'en-US'), voice('Zarvox', 'en-US'), voice('Thomas', 'fr-FR'), voice('Google UK English Female', 'en-GB', false)];

interface Rig { v: Voice; said: UtteranceLike[]; cancels: number; clock: { t: number }; engine: SpeechEngine; mute: boolean }

function rig(voices: VoiceLike[] = MAC, language = 'en-GB'): Rig {
  const said: UtteranceLike[] = [];
  const clock = { t: 0 };
  const r = { said, cancels: 0, clock, mute: false } as Rig;
  r.engine = {
    speaking: false,
    pending: false,
    getVoices: () => voices,
    // (Like a browser that is willing to speak, it reports the start of each line. `mute` makes it one that is not.)
    speak: (u) => { said.push(u); r.engine.speaking = true; if (!r.mute) u.onstart?.(); },
    cancel: () => { r.cancels++; r.engine.speaking = false; },
  };
  const make = (text: string): UtteranceLike => ({ text, lang: '', voice: null, pitch: 1, rate: 1, volume: 1, onstart: null, onend: null, onerror: null });
  r.v = new Voice(r.engine, make, () => clock.t, language);
  return r;
}
/** The engine reports that it has finished the line it was given last. */
const finish = (r: Rig) => { r.engine.speaking = false; r.said.at(-1)!.onend?.(); };

test('lines written for the screen are turned into lines a voice reads well', () => {
  assert.equal(spoken('ASTEROIDS COMING!'), 'asteroids coming!');
  assert.equal(spoken('FLY WITH WASD OR THE ARROW KEYS. HOLD SPACE TO FIRE.'), 'fly with W, A, S, D or the arrow keys. hold space to fire.');
  assert.equal(spoken('HIT A RED BOMB AND YOU MUST SOLVE IT, FAST. P PAUSES THE GAME.'), 'hit a red bomb and you must solve it, fast. P pauses the game.');
  assert.equal(spoken('NOOOOO!'), 'nooo!');
  assert.equal(spoken('THE HARD WAY HAS POWER-UPS.'), 'the hard way has power-ups.');
  // On-screen notes: the points are not read out.
  assert.equal(spoken('BOMB DEFUSED +300!'), 'bomb defused!');
  assert.equal(spoken('HULL IS FULL - BONUS 250!'), 'hull is full, bonus 250!');
  assert.equal(spoken('   '), '');
});

test('every line in the script survives being made speakable', () => {
  const script = [...Object.values(TAUNTS).flat(), ...BRIEFING.keys, ...BRIEFING.touch, ...BRIEFING.asteroids, ...BRIEFING.choice, BRIEFING.engines, BRIEFING.luck, BRIEFING.sonic];
  for (const line of script) {
    const out = spoken(line);
    assert.ok(out.length >= 3, line);
    assert.equal(out.replace(/[^a-z]/gi, '').toLowerCase().replace(/o+/g, 'o'), line.replace(/[^a-z]/gi, '').toLowerCase().replace(/o+/g, 'o'), `no words lost from: ${line}`);
  }
});

test('voices: English ones that run on the device, never a novelty, and different people where there is a choice', () => {
  const cast = castVoices(MAC, 'en-GB')!;
  assert.equal(cast.commander!.name, 'Daniel', 'the reader\'s own English, and the default');
  assert.equal(cast.pilot!.name, 'Samantha');
  assert.equal(cast.boss!.name, 'Fred');
  for (const v of Object.values(cast)) {
    assert.ok(v!.localService, 'nothing that sends the text to a server');
    assert.notEqual(v!.name, 'Zarvox');
    assert.match(v!.lang, /^en/);
  }
  assert.equal(castVoices(MAC, 'en-US')!.commander!.name, 'Samantha');
  assert.equal(castVoices(MAC, 'de-DE')!.commander!.name, 'Daniel', 'a reader in another language gets the script\'s British English');

  const two = castVoices([voice('Daniel', 'en-GB'), voice('Karen', 'en-AU')])!;
  assert.deepEqual([two.commander!.name, two.boss!.name, two.pilot!.name], ['Daniel', 'Daniel', 'Karen'], 'with no deeper voice to hand, the boss is the commander\'s voice pitched down');
  const one = castVoices([voice('Alex', 'en-US')])!;
  assert.deepEqual([one.commander!.name, one.boss!.name, one.pilot!.name], ['Alex', 'Alex', 'Alex'], 'one voice plays every part');
  assert.equal(castVoices([voice('Thomas', 'fr-FR'), voice('Google US English', 'en-US', false)]), null, 'no English voice on the device: stay silent');
  assert.deepEqual(castVoices([]), { commander: null, boss: null, pilot: null }, 'voices not listed yet: use the browser\'s default');
});

test('each speaker has a sound of their own: the boss deep and slow, the pilot high and quick', () => {
  const r = rig();
  r.v.say('pilot', 'FULL TANK!');
  finish(r);
  r.v.say('boss', 'YOU AGAIN?');
  finish(r);
  r.v.say('commander', 'GOOD LUCK, PILOT!');
  const [pilot, boss, commander] = r.said;
  assert.deepEqual([pilot!.text, boss!.text, commander!.text], ['full tank!', 'you again?', 'good luck, pilot!']);
  assert.ok(boss!.pitch < commander!.pitch && commander!.pitch < pilot!.pitch);
  assert.ok(boss!.rate < pilot!.rate);
  assert.equal(commander!.voice!.name, 'Daniel');
  assert.equal(commander!.lang, 'en-GB');
});

test('one line at a time: the commander talks over the boss, the boss over the pilot, and nobody queues', () => {
  const r = rig();
  assert.ok(r.v.say('boss', 'TICK TOCK!'));
  assert.ok(r.v.busy);
  assert.ok(!r.v.say('pilot', 'FULL TANK!'), 'the pilot waits for nobody and is not heard');
  assert.ok(r.v.say('boss', 'GOT YOU!'), 'the boss cuts in on itself');
  assert.ok(r.v.say('commander', 'ASTEROIDS COMING!'), 'and the commander cuts in on the boss');
  assert.ok(!r.v.say('boss', 'YAWN.'));
  assert.deepEqual(r.said.map((u) => u.text), ['tick tock!', 'got you!', 'asteroids coming!']);
  assert.equal(r.cancels, 2, 'a line that is cut in on is stopped');
  finish(r);
  assert.ok(!r.v.busy);
  assert.ok(r.v.say('pilot', 'NOT A SCRATCH!'), 'once the air is clear anyone can speak');
});

test('a line from a speaker who was cut off does not end the one that replaced it', () => {
  const r = rig();
  r.v.say('boss', 'TICK TOCK!');
  const first = r.said[0]!;
  r.v.say('commander', 'ASTEROIDS COMING!');
  first.onend?.();
  assert.ok(r.v.busy, 'the commander is still talking');
});

test('an engine that never says it has finished is not waited on for ever', () => {
  const r = rig();
  r.v.say('commander', 'COMMAND TO PILOT. WELCOME ABOARD!');
  r.clock.t = 3;
  assert.ok(r.v.busy);
  r.clock.t = 30;
  assert.ok(!r.v.busy);
  assert.ok(r.v.say('pilot', 'FULL TANK!'));
});

test('switched off, it says nothing and stops what was being said; hushing does the same for one line', () => {
  const r = rig();
  r.v.say('commander', 'COMMAND TO PILOT. WELCOME ABOARD!');
  r.v.setEnabled(false);
  assert.equal(r.cancels, 1);
  assert.ok(!r.v.busy);
  assert.ok(!r.v.say('boss', 'YOU AGAIN?'));
  assert.equal(r.said.length, 1);
  r.v.setEnabled(true);
  assert.ok(r.v.say('boss', 'YOU AGAIN?'));
  r.v.hush();
  assert.ok(!r.v.busy);
  assert.equal(r.cancels, 2);
});

test('a device with no English voice stays silent, and one with no speech at all does no harm', () => {
  const french = rig([voice('Thomas', 'fr-FR')]);
  assert.ok(!french.v.say('commander', 'GOOD LUCK, PILOT!'));
  assert.equal(french.said.length, 0);
  assert.ok(!french.v.busy);

  const none = new Voice(null);
  assert.ok(!none.say('commander', 'GOOD LUCK, PILOT!'));
  none.unlock();
  none.hush();
  none.dispose();
});

test('before the browser has listed its voices, lines are spoken in its default voice, in English', () => {
  const r = rig([], 'en-US');
  assert.ok(r.v.say('commander', 'GOOD LUCK, PILOT!'));
  assert.equal(r.said[0]!.voice, null);
  assert.equal(r.said[0]!.lang, 'en-US');
});

test('the first key press or tap says nothing, silently, so that a phone will let the game speak later', () => {
  const r = rig();
  r.v.unlock();
  r.v.unlock();
  assert.equal(r.said.length, 1, 'once the browser has spoken there is nothing more to unlock');
  assert.equal(r.said[0]!.volume, 0);
  assert.ok(!r.v.busy);
});

test('a browser that will not speak until a key press or tap is asked again at each one, and a waiting line is said then', () => {
  const r = rig();
  r.mute = true;
  // Before any key press: the browser swallows this without a sound.
  r.v.unlock();
  assert.ok(r.v.say('commander', 'COMMAND TO PILOT. WELCOME ABOARD!'));
  assert.equal(r.said.length, 2);
  // The pilot presses a key: now it is allowed, and the line that was waiting is said again from the top.
  r.mute = false;
  r.v.unlock();
  assert.equal(r.said.length, 3);
  assert.equal(r.said[2]!.text, 'command to pilot. welcome aboard!');
  assert.equal(r.said[2]!.volume > 0, true);
  assert.ok(r.v.busy);
  // And that is the end of it: later key presses do not restart lines.
  r.v.unlock();
  r.v.unlock();
  assert.equal(r.said.length, 3);

  // With nothing waiting, each key press tries the silent line until one is heard to start.
  const quiet = rig();
  quiet.mute = true;
  quiet.v.unlock();
  quiet.v.unlock();
  assert.deepEqual(quiet.said.map((u) => u.volume), [0, 0]);
  quiet.mute = false;
  quiet.v.unlock();
  quiet.v.unlock();
  assert.equal(quiet.said.length, 3);

  // A browser that never says a line has started is not asked for ever (or every key would restart the boss).
  const deaf = rig();
  deaf.mute = true;
  deaf.v.say('boss', 'TICK TOCK!');
  for (let i = 0; i < 20; i++) deaf.v.unlock();
  assert.ok(deaf.said.length <= 5, `${deaf.said.length} attempts`);
});

test('custom pilot voices: all 8 avatars have local-only voices, distinct pitch/rate tuning, and 3 speakable taglines', () => {
  for (const p of PILOTS) {
    assert.equal(p.taglines.length, 3, `${p.id} has 3 signature taglines`);
    for (const line of p.taglines) {
      const out = spoken(line.text);
      assert.ok(out.length >= 5, `${p.id} tagline is speakable: ${line.text}`);
      assert.equal(
        out.replace(/[^a-z0-9]/gi, '').toLowerCase(),
        line.text.replace(/[^a-z0-9]/gi, '').toLowerCase(),
        `no words lost from ${p.id} tagline: ${line.text}`,
      );
    }
    const chosen = pickPilotVoice(MAC, p.id, 'en-GB');
    assert.ok(chosen, `${p.id} resolves an on-device English voice`);
    assert.equal(chosen!.localService, true, `${p.id} never uses a network TTS voice`);
    assert.notEqual(chosen!.name, 'Zarvox', `${p.id} never picks a novelty voice`);
    assert.match(chosen!.lang, /^en/);
  }

  const r = rig();
  for (const id of PILOT_IDS) {
    const spec = PILOT_BY_ID[id];
    assert.ok(r.v.sayPilot(id, spec.taglines[0].text), `sayPilot speaks for ${id}`);
    const last = r.said.at(-1)!;
    assert.equal(last.pitch, spec.voice.pitch);
    assert.equal(last.rate, spec.voice.rate);
  }
  // Rapidly hovering multiple pilots cuts in cleanly on previous pilot previews,
  // while never talking over Flight Command!
  finish(r);
  assert.ok(r.v.say('commander', 'COMMAND TO NOVA IN THE STARHAWK. WELCOME ABOARD!'));
  assert.equal(r.v.sayPilot('fox', 'TOO FAST FOR RADAR!'), false, 'pilot preview never cuts off the commander');
  finish(r);

  // Selecting a pilot also tunes in-flight `say("pilot", ...)` callouts to that pilot's custom voice:
  r.v.setPilot('wolf');
  assert.ok(r.v.say('pilot', 'FULL TANK!'));
  assert.equal(r.said.at(-1)!.pitch, PILOT_BY_ID.wolf.voice.pitch);
  assert.equal(r.said.at(-1)!.rate, PILOT_BY_ID.wolf.voice.rate);

  // Unlocking after a muted hover utterance replays that exact pilot's voice:
  const locked = rig();
  locked.mute = true;
  assert.ok(locked.v.sayPilot('owl', 'CALCULATING OPTIMAL VECTOR.'));
  locked.mute = false;
  locked.v.unlock();
  assert.equal(locked.said.at(-1)!.pitch, PILOT_BY_ID.owl.voice.pitch);
  assert.equal(locked.said.at(-1)!.text, 'calculating optimal vector.');
});
