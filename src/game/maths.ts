/**
 * Simple maths problems for the arcade demo. `level` rises with the wave:
 * 1 is sums within 20, 2 adds bigger sums and the small times tables, 3 adds the full tables and division.
 */
export interface Problem {
  /** What is asked, e.g. "7 + 5". The game draws it as "7 + 5 = ?". */
  question: string;
  answer: number;
  /** The answer and two near misses, shuffled. */
  options: number[];
}

type Op = '+' | '-' | '×' | '÷';

const int = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1));

function shuffle<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = int(0, i);
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  return items;
}

/** Two numbers and the result. Subtraction never goes below zero and division always comes out whole. */
function operands(op: Op, level: number): [number, number, number] {
  if (op === '+') {
    const a = level === 1 ? int(1, 9) : level === 2 ? int(10, 40) : int(20, 70);
    const b = level === 1 ? int(1, 9) : level === 2 ? int(2, 19) : int(11, 29);
    return [a, b, a + b];
  }
  if (op === '-') {
    const b = level === 1 ? int(1, 8) : level === 2 ? int(2, 14) : int(11, 29);
    const result = level === 1 ? int(1, 9) : level === 2 ? int(5, 35) : int(10, 60);
    return [b + result, b, result];
  }
  if (op === '×') {
    const a = level === 2 ? int(2, 5) : int(3, 9);
    const b = int(2, 9);
    return [a, b, a * b];
  }
  const b = int(2, 9);
  const result = int(2, 9);
  return [b * result, b, result];
}

export function makeProblem(level: number): Problem {
  const ops: Op[] = level <= 1 ? ['+', '+', '-'] : level === 2 ? ['+', '-', '×'] : ['+', '-', '×', '×', '÷'];
  const op = ops[int(0, ops.length - 1)]!;
  const [a, b, answer] = operands(op, level);
  // Near misses are the slips a student actually makes: off by one or two, off by ten in a bigger sum,
  // or one row out in a times table.
  const near = new Set([answer + 1, answer - 1, answer + 2, answer - 2]);
  if (answer >= 20) [answer + 10, answer - 10].forEach((n) => near.add(n));
  if (op === '×') [a * (b + 1), a * (b - 1), (a + 1) * b].forEach((n) => near.add(n));
  const wrong = shuffle([...near].filter((n) => n > 0 && n !== answer)).slice(0, 2);
  return { question: `${a} ${op} ${b}`, answer, options: shuffle([answer, ...wrong]) };
}
