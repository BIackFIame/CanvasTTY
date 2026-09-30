import { basename } from "node:path";
import type { AgentChatHistoryItem } from "../../../shared/contracts.ts";
import { historyFiles, historyItem, historyPromptTitle, missing, readJsonLines, readJsonMetadata, record, type HistoryAdapter } from "./historyFiles.ts";

type JsonlProvider = "claude" | "qwen" | "pi" | "omp";

export function jsonlHistory(provider: JsonlProvider, roots: string | string[]): HistoryAdapter {
  return { async read(signal) {
    const items = new Map<string, AgentChatHistoryItem>();
    let skipped = 0;
    let foundStore = false;
    let absentStore: unknown;
    for (const root of typeof roots === "string" ? [roots] : roots) {
      try {
        for await (const path of historyFiles(root, (name) => name.endsWith(".jsonl"), signal)) {
          try {
            const { rows, modifiedAt } = await readJsonMetadata(path, signal);
            const header = rows.find((row) => provider === "pi" || provider === "omp"
              ? row.type === "session" : typeof row.sessionId === "string" && typeof row.cwd === "string");
            if (!header) { skipped += 1; continue; }
            if (header.isSidechain === true) continue;
            let title = typeof header.title === "string" ? header.title : "";
            const readTitle = (row: Record<string, unknown>): void => {
              const payload = record(row.systemPayload);
              if (row.type === "session_info" && typeof row.name === "string") title = row.name;
              if (["title", "title_change"].includes(String(row.type)) && typeof row.title === "string") title = row.title;
              if (row.type === "custom-title" && typeof row.customTitle === "string") title = row.customTitle;
              if (row.type === "summary" && typeof row.summary === "string" && !title) title = row.summary;
              if (row.subtype === "custom_title" && typeof payload.customTitle === "string") title = payload.customTitle;
            };
            for (const row of rows) readTitle(row);
            // Claude/Pi do not keep renamed titles in a fixed header or tail slot.
            // Stream only their small title records; do not parse message bodies.
            if (provider === "claude" || provider === "pi") {
              await readJsonLines(path, (value) => readTitle(record(value)), signal,
                (line) => /"type"\s*:\s*"(?:custom-title|summary|session_info)"/.test(line));
            }
            if (!title) {
              const user = rows.find((row) => row.type === "user" || (row.type === "message" && record(row.message).role === "user"));
              const message = record(user?.message);
              title = historyPromptTitle(message.content ?? message.parts ?? user?.message ?? user?.content);
            }
            const item = historyItem(provider, {
              id: header.sessionId ?? header.id ?? basename(path, ".jsonl"),
              cwd: header.cwd, title, lastActivityAt: modifiedAt
            });
            if (!item) { skipped += 1; continue; }
            const existing = items.get(item.id);
            if (!existing || existing.lastActivityAt < item.lastActivityAt) items.set(item.id, item);
          } catch { signal.throwIfAborted(); skipped += 1; }
        }
        foundStore = true;
      } catch (error) {
        if (!missing(error)) throw error;
        absentStore = error;
      }
    }
    if (!foundStore && absentStore) throw absentStore;
    return { items: [...items.values()], skipped };
  } };
}
