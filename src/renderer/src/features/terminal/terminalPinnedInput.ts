export interface TerminalBufferLineLike {
  readonly isWrapped: boolean;
  translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string;
}

export interface TerminalBufferLike {
  readonly type: "normal" | "alternate";
  readonly baseY: number;
  readonly viewportY: number;
  readonly cursorY: number;
  readonly cursorX: number;
  getLine(index: number): TerminalBufferLineLike | undefined;
}

export interface PinnedTerminalInput {
  rows: string[];
  cursorRow: number;
  cursorColumn: number;
}

export function limitPinnedTerminalInput(input: PinnedTerminalInput, maxRows: number): PinnedTerminalInput {
  const capacity = Math.max(1, Math.floor(maxRows));
  if (input.rows.length <= capacity) return input;
  const firstRow = Math.max(
    0,
    Math.min(input.rows.length - capacity, input.cursorRow - Math.floor(capacity / 2))
  );
  return {
    rows: input.rows.slice(firstRow, firstRow + capacity),
    cursorRow: input.cursorRow - firstRow,
    cursorColumn: input.cursorColumn
  };
}

/** The complete live logical cursor line while normal scrollback is away from the bottom. */
export function pinnedTerminalInput(buffer: TerminalBufferLike): PinnedTerminalInput | null {
  if (buffer.type !== "normal" || buffer.viewportY >= buffer.baseY) return null;
  const cursorLine = buffer.baseY + buffer.cursorY;
  if (!buffer.getLine(cursorLine)) return null;

  let firstLine = cursorLine;
  while (firstLine > 0 && buffer.getLine(firstLine)?.isWrapped) firstLine -= 1;

  let lastLine = cursorLine;
  while (buffer.getLine(lastLine + 1)?.isWrapped) lastLine += 1;

  const rows: string[] = [];
  for (let line = firstLine; line <= lastLine; line += 1) {
    const bufferLine = buffer.getLine(line);
    if (!bufferLine) return null;
    rows.push(bufferLine.translateToString(true));
  }
  return {
    rows,
    cursorRow: cursorLine - firstLine,
    cursorColumn: buffer.cursorX
  };
}
