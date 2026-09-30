import { basename, dirname, join } from "node:path";
import { lstat } from "node:fs/promises";
import type { AgentChatHistoryItem } from "../../../shared/contracts.ts";
import { historyFiles, historyItem, readJson, record, type HistoryAdapter } from "./historyFiles.ts";

export function cursorHistory(home: string): HistoryAdapter {
  return { async read(signal) {
    const items = new Map<string, AgentChatHistoryItem>();
    let skipped = 0;
    for await (const path of historyFiles(join(home, "chats"), (name) => name === "store.db", signal)) {
      try {
        const metadataPath = join(dirname(path), "meta.json");
        if (!(await lstat(metadataPath)).isFile()) { skipped += 1; continue; }
        const metadata = record(await readJson(metadataPath));
        if (metadata.schemaVersion !== 1) { skipped += 1; continue; }
        if (metadata.hasConversation !== true || metadata.isSubagent === true) continue;
        const item = historyItem("cursor", {
          id: basename(dirname(path)), title: metadata.title, cwd: metadata.cwd,
          lastActivityAt: metadata.updatedAtMs ?? metadata.createdAtMs
        });
        if (!item) { skipped += 1; continue; }
        const existing = items.get(item.id);
        if (!existing || existing.lastActivityAt < item.lastActivityAt) items.set(item.id, item);
      } catch { signal.throwIfAborted(); skipped += 1; }
    }
    return { items: [...items.values()], skipped };
  } };
}
