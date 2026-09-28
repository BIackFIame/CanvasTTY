// Newline-delimited JSON framing, shared by the main process (gateways, service
// supervisor, limits client) and the helpers that run inside agent processes
// (runtime client, permission gate, MCP helpers). One place decides how a line
// is cut and how a line that is too long is bounded, so every reader keeps the
// same memory bound.

const NEWLINE = 0x0a;

/** Thrown by `NdjsonLineReader.push` for a line over the limit when no `onOversize` is given. */
export class NdjsonLineTooLongError extends Error {
  constructor(maxLineBytes) {
    super(`NDJSON line exceeds ${maxLineBytes} bytes.`);
    this.name = "NdjsonLineTooLongError";
  }
}

/**
 * Cuts a byte stream into lines. `push` returns the lines each chunk completes,
 * without their "\n", empty ones included. At most `maxLineBytes` of one line
 * are ever buffered: a line over the limit, complete or still unterminated, is
 * never returned. `onOversize` is called once for it (its throw propagates out
 * of `push`; without it `push` throws `NdjsonLineTooLongError`), and when it
 * returns, the line's bytes up to the next newline are dropped.
 */
export class NdjsonLineReader {
  #maxLineBytes;
  #onOversize;
  #remainder = Buffer.alloc(0);
  #skipping = false;

  constructor({ maxLineBytes, onOversize } = {}) {
    if (!(typeof maxLineBytes === "number" && maxLineBytes > 0)) throw new TypeError("maxLineBytes must be positive.");
    this.#maxLineBytes = maxLineBytes;
    this.#onOversize = onOversize ?? (() => { throw new NdjsonLineTooLongError(maxLineBytes); });
  }

  push(chunk) {
    let buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    if (this.#skipping) {
      const newline = buffer.indexOf(NEWLINE);
      if (newline < 0) return [];
      this.#skipping = false;
      buffer = buffer.subarray(newline + 1);
    }
    if (this.#remainder.length > 0) buffer = Buffer.concat([this.#remainder, buffer]);
    this.#remainder = Buffer.alloc(0);
    const lines = [];
    let start = 0;
    for (let newline = buffer.indexOf(NEWLINE); newline >= 0; newline = buffer.indexOf(NEWLINE, start)) {
      const line = buffer.subarray(start, newline);
      start = newline + 1;
      if (line.length > this.#maxLineBytes) this.#onOversize();
      else lines.push(line);
    }
    const rest = buffer.subarray(start);
    if (rest.length > this.#maxLineBytes) {
      this.#skipping = true;
      this.#onOversize();
    } else if (rest.length > 0) {
      // A copy: the caller's chunk must not stay pinned by a view into it.
      this.#remainder = Buffer.from(rest);
    }
    return lines;
  }
}

/**
 * Decodes newline-delimited JSON messages. Empty lines are skipped; a line over
 * `maxLineBytes` throws `tooLarge()`, a line that is not JSON throws `invalid()`.
 */
export class NdjsonDecoderBase {
  #lines;
  #invalid;

  constructor({ maxLineBytes, tooLarge, invalid }) {
    this.#lines = new NdjsonLineReader({ maxLineBytes, onOversize: () => { throw tooLarge(); } });
    this.#invalid = invalid;
  }

  push(chunk) {
    const messages = [];
    for (const line of this.#lines.push(chunk)) {
      if (line.length === 0) continue;
      try {
        messages.push(JSON.parse(line.toString("utf8")));
      } catch {
        throw this.#invalid();
      }
    }
    return messages;
  }
}
