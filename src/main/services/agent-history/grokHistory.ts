import { join } from "node:path";
import type { AgentChatHistoryItem } from "../../../shared/contracts.ts";
import { historyFiles, historyItem, readJson, record, type HistoryAdapter, type HistoryRecords } from "./historyFiles.ts";

export function grokHistory(home: string): HistoryAdapter {
  return { async read(signal): Promise<HistoryRecords> {
    const items = new Map<string, AgentChatHistoryItem>();
    let skipped = 0;
    for await (const path of historyFiles(join(home, "sessions"), (name) => name === "summary.json", signal)) {
      try {
        const summary = record(await readJson(path));
        const info = record(summary.info);
        const item = historyItem("grok", {
          id: info.id, cwd: info.cwd,
          title: summary.generated_title || summary.session_summary,
          lastActivityAt: Date.parse(String(summary.last_active_at || summary.updated_at || summary.created_at))
        });
        if (item) {
          const previous = items.get(item.id);
          if (!previous || previous.lastActivityAt < item.lastActivityAt) items.set(item.id, item);
        } else skipped += 1;
      } catch { signal.throwIfAborted(); skipped += 1; }
    }
    return { items: [...items.values()], skipped };
  } };
}
