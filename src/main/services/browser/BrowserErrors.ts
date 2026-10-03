import type { BrowserError, BrowserErrorCode } from "../../../shared/contracts.ts";

export class BrowserKernelError extends Error {
  readonly code: BrowserErrorCode;
  readonly retryable: boolean;
  readonly details?: Record<string, string | number | boolean | null>;

  constructor(
    code: BrowserErrorCode,
    message: string,
    options: {
      retryable?: boolean;
      details?: Record<string, string | number | boolean | null>;
      cause?: unknown;
    } = {}
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "BrowserKernelError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

/**
 * Why a tab driven by a contributed engine moves to Chromium: the page looked like a bot wall, its text came out thin
 * for its size, the engine lacks a CDP method or an action, a screenshot was asked for, the engine went away, the
 * tab became visible to the person, or it navigated to a site that already needed Chromium in this session.
 */
export type EngineFallbackReason =
  | "bot-wall"
  | "thin-text"
  | "unsupported-method"
  | "unsupported-action"
  | "screenshot"
  | "engine-disconnected"
  | "revealed"
  | "remembered-site";

/**
 * Thrown by automation on a tab a contributed engine drives when that tab has to continue in Chromium. BrowserCore
 * moves the tab (same tab id, next document revision) and runs the command again there; it never reaches an agent.
 */
export class EngineFallbackRequired extends Error {
  readonly reason: EngineFallbackReason;

  constructor(reason: EngineFallbackReason, message = `Browser engine cannot continue: ${reason}.`) {
    super(message);
    this.name = "EngineFallbackRequired";
    this.reason = reason;
  }
}

export function browserError(error: unknown): BrowserError {
  if (error instanceof BrowserKernelError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.details ? { details: error.details } : {})
    };
  }

  if (isAbortError(error)) {
    return {
      code: "CANCELED",
      message: "Browser command was canceled.",
      retryable: true
    };
  }

  return {
    code: "BRIDGE_UNAVAILABLE",
    message: "Browser command failed inside the protected browser runtime.",
    retryable: true
  };
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new DOMException("Browser command was canceled.", "AbortError");
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
    || error instanceof Error && error.name === "AbortError";
}
