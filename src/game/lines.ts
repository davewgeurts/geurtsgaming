/**
 * Lines for the typing break before each wave. Upper case letters and single spaces only:
 * that is all the stroke font draws, and it keeps the match fair on any keyboard layout.
 * Grouped short to long; later waves draw from the longer groups.
 */
export const LINES: readonly (readonly string[])[] = [
  [
    'FULL POWER',
    'SHIELDS UP',
    'STARS AHEAD',
    'READY TO FLY',
    'FIX THE HULL',
    'HOLD THE LINE',
    'CHARGE LASERS',
    'FAST FINGERS',
  ],
  [
    'FAST FINGERS WIN',
    'KEEP YOUR EYES UP',
    'TYPE FAST FLY FAR',
    'DODGE THE PINK DARTS',
    'REPAIR THE SHIP FAST',
    'CHARGE THE LASERS NOW',
    'PRACTICE MAKES PILOTS',
    'EVERY KEY IS A SPARK',
  ],
  [
    'EVERY KEY CHARGES THE ENGINE',
    'HOME ROW IS WHERE HEROES START',
    'QUICK HANDS KEEP THE SHIP FLYING',
    'A CALM PILOT MAKES NO MISTAKES',
    'SLOW IS SMOOTH AND SMOOTH IS FAST',
    'THE BEST PILOTS TYPE WITHOUT LOOKING',
    'ACCURACY FIRST AND SPEED WILL FOLLOW',
    'SMALL STEPS ADD UP TO BIG JOURNEYS',
    'A STEADY RHYTHM BEATS A FRANTIC RUSH',
    'LOOK AT THE SCREEN AND TRUST YOUR HANDS',
    'EVERY MISTAKE TEACHES YOU SOMETHING NEW',
    'GREAT PILOTS PRACTICE A LITTLE EVERY DAY',
    'KEEP YOUR FINGERS CLOSE TO THE HOME ROW',
    'THE STARS ARE CLOSER THAN THEY LOOK',
  ],
];

/** Single words for the quick typing question a boost capsule can ask in the middle of a wave. */
export const WORDS: readonly string[] = [
  'STAR', 'NOVA', 'LASER', 'COMET', 'ORBIT', 'PILOT', 'TURBO', 'BLAST', 'POWER',
  'ROCKET', 'PLANET', 'SHIELD', 'ENGINE', 'GALAXY', 'METEOR', 'THRUST',
];

/**
 * Things the mini boss says, by what has just happened. They are meant to be silly rather than mean,
 * and none of them makes fun of a wrong answer to a sum.
 */
export const TAUNTS = {
  enter: ['FRESH PILOT. YUM!', 'YOU AGAIN?', 'NOBODY BEATS ME!', 'PREPARE TO LOSE!', 'OH LOOK. A SNACK!'],
  idle: ['IS THAT ALL?', 'YAWN.', 'YOU CANNOT WIN!', 'MY GRANNY FLIES BETTER!', 'OVER HERE, PILOT!', 'TICK TOCK!'],
  hit: ['HA HA HA!', 'GOT YOU!', 'TOO SLOW!', 'BULLSEYE!', 'OOPS. DID THAT HURT?'],
  blocked: ['MY ARMOUR LAUGHS AT YOU!', 'THAT TICKLES!', 'NICE TRY!'],
  ouch: ['OW!', 'HEY! STOP THAT!', 'LUCKY SHOT!', 'NOT THE CORE!'],
  arm: ['MY ARM!', 'I LIKED THAT ARM!', 'HEY! I NEED THOSE!'],
  right: ['HOW DID YOU KNOW?', 'NO! MY ARMOUR!', 'YOU ARE TOO CLEVER!'],
  wrong: ['WRONG SHIP! HA HA!', 'NOPE!', 'TRY AGAIN, PILOT!'],
  bomb: ['CATCH!', 'A GIFT FOR YOU!', 'SOLVE THIS!', 'THINK FAST!'],
  defused: ['NO FAIR!', 'THAT WAS MY BEST BOMB!', 'SHOW OFF!'],
  boom: ['BOOM! HA HA HA!'],
  low: ['THIS IS NOT FUNNY NOW!', 'WAIT. LET US TALK!', 'TIME OUT! TIME OUT!'],
  down: ['NOOOOO!', 'I WILL BE BACK!', 'THIS IS NOT OVER!'],
  bored: ['BORING. BYE!', 'I HAVE BETTER THINGS TO DO!'],
  win: ['HA HA HA HA HA!', 'BYE BYE, PILOT!', 'TOO EASY!'],
} as const;
export type Taunt = keyof typeof TAUNTS;

/**
 * What the flight commander says over the cockpit radio before take-off: how to play, in a few short
 * lines, and a send-off. `keys` is for a keyboard, `touch` for a touch screen (where nothing is typed).
 */
export const BRIEFING = {
  keys: [
    'COMMAND TO PILOT. WELCOME ABOARD!',
    'FLY WITH WASD OR THE ARROW KEYS. HOLD SPACE TO FIRE.',
    'BEFORE EACH WAVE, TYPE THE WORDS. GOOD TYPING CHARGES YOUR CANNONS.',
    'EVERY SHIP YOU BEAT SETS FREE SOMEONE TRAPPED INSIDE. SAVE THEM ALL!',
    'FLY INTO CAPSULES AND ANSWER TO WIN BOOSTS AND UPGRADES.',
    'A FUEL SHIP VISITS EVERY WAVE. HOOK ON TO ITS FUEL LINE AND HOLD ON!',
    'WHEN ASTEROIDS COME, PICK A WAY THROUGH. THE HARD WAY HAS POWER-UPS.',
    'HIT A RED BOMB AND YOU MUST SOLVE IT, FAST. P PAUSES THE GAME.',
    'READY WHEN YOU ARE. PRESS SPACE TO LAUNCH!',
  ],
  touch: [
    'COMMAND TO PILOT. WELCOME ABOARD!',
    'DRAG YOUR FINGER TO FLY. THE SHIP FIRES WHILE YOU TOUCH.',
    'BEFORE EACH WAVE, SOLVE THREE SUMS. RIGHT ANSWERS CHARGE YOUR CANNONS.',
    'EVERY SHIP YOU BEAT SETS FREE SOMEONE TRAPPED INSIDE. SAVE THEM ALL!',
    'FLY INTO CAPSULES AND ANSWER TO WIN BOOSTS AND UPGRADES.',
    'A FUEL SHIP VISITS EVERY WAVE. HOOK ON TO ITS FUEL LINE AND HOLD ON!',
    'WHEN ASTEROIDS COME, PICK A WAY THROUGH. THE HARD WAY HAS POWER-UPS.',
    'HIT A RED BOMB AND YOU MUST SOLVE IT, FAST.',
    'READY WHEN YOU ARE. TAP TO LAUNCH!',
  ],
  engines: 'ENGINES TO FULL. HERE WE GO!',
  /** The warning before an asteroid field: a headline and what to do about it, then the choice of ways through. */
  asteroids: ['ASTEROIDS COMING!', 'TAKE EVASIVE MANOEUVRES!'],
  choice: ['LOOK, PILOT! THERE IS AN EASIER WAY WITH BOMBS,', 'OR A HARDER PATH WITH POWER-UPS.', 'CHOOSE WISELY!'],
  luck: 'GOOD LUCK, PILOT!',
  sonic: 'GOING SUPERSONIC!',
} as const;
