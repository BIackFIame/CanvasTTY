import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { normalizeThreadId } from "../../../agent-runtime/runtime-protocol.mjs";
import type { AgentChatHistoryItem } from "../../../shared/contracts.ts";
import { historyItem, historyPromptTitle, missing, readJson, readJsonMetadata, record, type HistoryAdapter } from "./historyFiles.ts";

export function kimiHistory(home: string): HistoryAdapter {
  return { async read(signal) {
    signal.throwIfAborted();
    const metadata = record(await readJson(join(home, "kimi.json")));
    const items = new Map<string, AgentChatHistoryItem>();
    let skipped = 0;
    for (const workDir of Array.isArray(metadata.work_dirs) ? metadata.work_dirs.map(record) : []) {
      signal.throwIfAborted();
      if (typeof workDir.path !== "string" || (workDir.kaos && workDir.kaos !== "local")) continue;
      const root = join(home, "sessions", createHash("md5").update(workDir.path).digest("hex"));
      let entries;
      try { entries = await readdir(root, { withFileTypes: true }); }
      catch (error) { if (missing(error)) continue; throw error; }
      for (const entry of entries) {
        if (!entry.isDirectory() || !normalizeThreadId("kimi", entry.name)) continue;
        signal.throwIfAborted();
        try {
          const dir = join(root, entry.name);
          const context = await lstat(join(dir, "context.jsonl"));
          if (!context.isFile()) { skipped += 1; continue; }
          let title = "";
          try {
            if ((await lstat(join(dir, "state.json"))).isFile()) {
              const state = record(await readJson(join(dir, "state.json")));
              title = String(state.custom_title ?? state.title ?? "");
            }
          } catch (error) { if (!missing(error)) throw error; }
          if (!title || title === "Untitled") {
            const { rows } = await readJsonMetadata(join(dir, "context.jsonl"), signal);
            title = historyPromptTitle(rows.find((row) => row.role === "user")?.content);
          }
          const item = historyItem("kimi", { id: entry.name, cwd: workDir.path, title, lastActivityAt: context.mtimeMs });
          if (item) items.set(item.id, item); else skipped += 1;
        } catch { signal.throwIfAborted(); skipped += 1; }
      }
    }
    return { items: [...items.values()], skipped };
  } };
}
