import { join } from "node:path";
import { sqliteHistory, type HistoryAdapter } from "./historyFiles.ts";

export function opencodeHistory(home: string): HistoryAdapter {
  return { read: (signal) => sqliteHistory(join(home, "opencode.db"), "opencode", signal) };
}
