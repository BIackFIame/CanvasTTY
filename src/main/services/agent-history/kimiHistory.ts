import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { normalizeThreadId } from "../../../agent-runtime/runtime-protocol.mjs";
import type { AgentChatHistoryItem } from "../../../shared/contracts.ts";
import { historyFiles, historyItem, historyPromptTitle, missing, readJson, readJsonLines, readJsonMetadata, record, type HistoryAdapter } from "./historyFiles.ts";

export function kimiHistory(home: string, codeHome?: string): HistoryAdapter {
  const legacy = legacyKimiHistory(home);
  return { async read(signal) {
    if (!codeHome) return legacy.read(signal);
    let modern: Awaited<ReturnType<HistoryAdapter["read"]>> | undefined;
    let modernError: unknown;
    try { modern = await kimiCodeHistory(codeHome).read(signal); }
    catch (error) { if (!missing(error)) throw error; modernError = error; }
    let old: Awaited<ReturnType<HistoryAdapter["read"]>> | undefined;
    let legacyError: unknown;
    try { old = await legacy.read(signal); }
    catch (error) { if (!missing(error)) throw error; legacyError = error; }
    if (!modern && !old) throw legacyError ?? modernError;
    const modernItems = modern?.items ?? [];
    const migratedLegacyIds = new Set(modernItems.map(legacyIdForModern).filter((id): id is string => Boolean(id)));
    return {
      items: [...modernItems, ...(old?.items ?? []).filter(item => !migratedLegacyIds.has(item.id))],
      skipped: (modern?.skipped ?? 0) + (old?.skipped ?? 0)
    };
  } };
}

function legacyIdForModern(item: AgentChatHistoryItem): string | undefined {
  const native = item.id.startsWith("session_") ? item.id.slice(8) : item.id.startsWith("ses_") ? item.id.slice(4) : "";
  return normalizeThreadId("kimi", native);
}

function kimiCodeHistory(home: string): HistoryAdapter {
  return { async read(signal) {
    const items: AgentChatHistoryItem[] = [];
    let skipped = 0;
    for await (const path of historyFiles(join(home, "sessions"), name => name === "state.json", signal)) {
      const id = basename(dirname(path));
      if ((!id.startsWith("session_") && !id.startsWith("ses_")) || !normalizeThreadId("kimi", id)) continue;
      try {
        const state = record(await readJson(path));
        if (state.id !== id || state.version !== 2) { skipped += 1; continue; }
        if (record(state.custom).child_session_kind === "child") continue;
        let title = historyPromptTitle(state.title) || historyPromptTitle(state.lastPrompt);
        if (!title) {
          try {
            await readJsonLines(join(dirname(path), "agents", "main", "wire.jsonl"), value => {
              const row = record(value);
              if (row.type === "turn.prompt" && row.agentId === "main" && record(row.origin).kind === "user") {
                title = historyPromptTitle(row.input) || title;
              }
            }, signal, line => /"type"\s*:\s*"turn\.prompt"/.test(line));
          } catch (error) { if (!missing(error)) throw error; }
        }
        const item = historyItem("kimi", {
          id, cwd: state.cwd, title,
          lastActivityAt: state.updatedAt ?? state.createdAt
        });
        if (item) items.push(item); else skipped += 1;
      } catch { signal.throwIfAborted(); skipped += 1; }
    }
    return { items, skipped };
  } };
}

function legacyKimiHistory(home: string): HistoryAdapter {
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
