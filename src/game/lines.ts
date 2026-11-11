/**
 * Lines for the typing break between waves. Upper case letters and single spaces only:
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
  ],
];
