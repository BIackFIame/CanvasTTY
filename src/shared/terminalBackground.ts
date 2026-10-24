import { TERMINAL_BACKGROUND_CATALOG } from "./terminalBackgroundCatalog.ts";
export { TERMINAL_BACKGROUND_CATALOG };
export const TERMINAL_BACKGROUNDS = TERMINAL_BACKGROUND_CATALOG.map((piece) => piece.id);
const backgroundIds = new Set<string>(TERMINAL_BACKGROUNDS);

export type TerminalBackgroundId = "none" | typeof TERMINAL_BACKGROUND_CATALOG[number]["id"];

export function isTerminalBackgroundId(value: unknown): value is TerminalBackgroundId {
  return value === "none" || (typeof value === "string" && backgroundIds.has(value));
}
