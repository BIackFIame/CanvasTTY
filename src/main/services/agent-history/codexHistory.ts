import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AgentChatHistoryItem } from "../../../shared/contracts.ts";
import { historyFiles, historyItem, missing, readJson, readJsonLines, record, sqliteHistory, type HistoryAdapter, type HistoryRecords } from "./historyFiles.ts";

export function codexHistory(home: string): HistoryAdapter {
  return { async read(signal): Promise<HistoryRecords> {
    const databases = (await readdir(home)).filter((name) => /^state_\d+\.sqlite$/.test(name))
      .sort((a, b) => Number(b.match(/\d+/)![0]) - Number(a.match(/\d+/)![0]));
    if (databases[0]) return sqliteHistory(join(home, databases[0]), "codex", signal);

    // Older Codex stores metadata in rollouts; the index supplies renamed titles.
    const titles = new Map<string, Record<string, unknown>>();
    let skipped = 0;
    try {
      skipped += await readJsonLines(join(home, "session_index.jsonl"), (value) => {
        const row = record(value);
        if (typeof row.id === "string") titles.set(row.id, row);
      }, signal);
    } catch (error) { if (!missing(error)) throw error; }
    const items = new Map<string, AgentChatHistoryItem>();
    for (const folder of ["sessions", "archived_sessions"]) {
      try {
        for await (const path of historyFiles(join(home, folder), (name) => name.startsWith("rollout-") && name.endsWith(".jsonl"), signal)) {
          try {
            const first = record(await readJson(path, true));
            if (first.type !== "session_meta") { skipped += 1; continue; }
            const meta = record(first.payload);
            const index = titles.get(String(meta.id ?? meta.session_id));
            const item = historyItem("codex", {
              id: meta.id ?? meta.session_id, cwd: meta.cwd, title: index?.thread_name,
              lastActivityAt: Math.max((await stat(path)).mtimeMs, Date.parse(String(index?.updated_at ?? meta.timestamp ?? first.timestamp)) || 0)
            });
            if (item) items.set(item.id, item); else skipped += 1;
          } catch { signal.throwIfAborted(); skipped += 1; }
        }
      } catch (error) { if (!missing(error)) throw error; }
    }
    return { items: [...items.values()], skipped };
  } };
}
