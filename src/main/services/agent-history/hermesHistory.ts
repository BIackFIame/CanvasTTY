import { join } from "node:path";
import { sqliteHistory, type HistoryAdapter } from "./historyFiles.ts";

export function hermesHistory(home: string): HistoryAdapter {
  return { read: (signal) => sqliteHistory(join(home, "state.db"), "hermes", signal) };
}
