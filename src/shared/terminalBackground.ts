import { TERMINAL_BACKGROUND_CATALOG } from "./terminalBackgroundCatalog.ts";
export { TERMINAL_BACKGROUND_CATALOG };
export const TERMINAL_BACKGROUNDS = TERMINAL_BACKGROUND_CATALOG.map((piece) => piece.id);
const backgroundIds = new Set<string>(TERMINAL_BACKGROUNDS);

export type TerminalBackgroundId = "none" | typeof TERMINAL_BACKGROUND_CATALOG[number]["id"];

export function isTerminalBackgroundId(value: unknown): value is TerminalBackgroundId {
  return value === "none" || (typeof value === "string" && backgroundIds.has(value));
}

export interface AsciiPiece {
  meta: {
    cols?: number;
    rows?: number;
    fps?: number;
    still?: number;
    palette?: string[];
    ground?: string;
    cell?: number;
    fineDots?: boolean;
    fullBleed?: boolean;
    cover?: boolean;
    contain?: boolean;
    options?: Record<string, unknown>;
  };
  default(options: Record<string, unknown>): (time: number, env: { paper: boolean; color?: Uint8Array }) => string;
}
