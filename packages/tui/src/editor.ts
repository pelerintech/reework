// The input line: text with a cursor, and the history of sent lines.
export interface LineState {
  readonly text: string;
  readonly cursor: number;
}

export const emptyLine: LineState = { text: "", cursor: 0 };

export function insert(line: LineState, chars: string): LineState {
  return {
    text: line.text.slice(0, line.cursor) + chars + line.text.slice(line.cursor),
    cursor: line.cursor + chars.length,
  };
}

export function backspace(line: LineState): LineState {
  if (line.cursor === 0) return line;
  return {
    text: line.text.slice(0, line.cursor - 1) + line.text.slice(line.cursor),
    cursor: line.cursor - 1,
  };
}

export function move(line: LineState, by: number): LineState {
  return { ...line, cursor: Math.min(line.text.length, Math.max(0, line.cursor + by)) };
}

export function lineOf(text: string): LineState {
  return { text, cursor: text.length };
}

/** Step through sent lines: `-1` older, `+1` newer; past the newest is an empty line. */
export function recall(history: readonly string[], position: number, by: number) {
  const next = Math.min(history.length, Math.max(0, position + by));
  return { position: next, line: lineOf(history[next] ?? "") };
}
