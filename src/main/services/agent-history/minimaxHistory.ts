import { join } from "node:path";
import { missing, sqliteHistory, type HistoryAdapter } from "./historyFiles.ts";

export function minimaxHistory(home: string): HistoryAdapter {
  return { async read(signal) {
    try { return await sqliteHistory(join(home, "v2", "sqlite", "runtime-state.sqlite"), "minimax", signal); }
    catch (error) {
      if (!missing(error)) throw error;
      return sqliteHistory(join(home, "v2", "chats", "local-runtime.sqlite"), "minimax", signal);
    }
  } };
}
