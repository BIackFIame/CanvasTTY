export class NdjsonLineTooLongError extends Error {
  constructor(maxLineBytes: number);
}

export class NdjsonLineReader {
  constructor(options: { maxLineBytes: number; onOversize?: () => void });
  push(chunk: Buffer | string): Buffer[];
}

export class NdjsonDecoderBase {
  constructor(options: { maxLineBytes: number; tooLarge: () => Error; invalid: () => Error });
  push(chunk: Buffer | string): unknown[];
}
