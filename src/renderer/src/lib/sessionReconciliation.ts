import type { SessionMetadata, SessionSnapshot } from "../../../shared/contracts";

/**
 * Merges a list loaded earlier (the startup `terminal.list()`) into the live state. `removed` holds the ids
 * a removal event dropped while the list was on its way: the list is older than that removal, so it must not
 * bring those cards back.
 */
export function mergeSessionSnapshots(
  current: SessionSnapshot[],
  loaded: readonly SessionSnapshot[],
  removed: ReadonlySet<string> = new Set()
): SessionSnapshot[] {
  return loaded.reduce((sessions, next) => removed.has(next.id) ? sessions : upsertSnapshot(sessions, next), current);
}

export function upsertSession(
  sessions: SessionSnapshot[],
  metadata: SessionMetadata
): SessionSnapshot[] {
  const existing = sessions.find((session) => session.id === metadata.id);
  return upsertSnapshot(sessions, { ...metadata, buffer: existing?.buffer ?? "" });
}

export function upsertSnapshot(
  sessions: SessionSnapshot[],
  next: SessionSnapshot
): SessionSnapshot[] {
  const index = sessions.findIndex((session) => session.id === next.id);
  if (index < 0) return [...sessions, next];

  const existing = sessions[index];
  if (next.revision < existing.revision) {
    if (existing.buffer || !next.buffer) return sessions;
    return sessions.map((session) => session.id === next.id
      ? { ...existing, buffer: next.buffer }
      : session);
  }
  return sessions.map((session) => session.id === next.id ? next : session);
}
