import type { PluginPermission } from "../../../../shared/contracts";

/**
 * `sessions.focus` from a plugin page: which open card to bring to the front, or why not. The page needs
 * `sessions:read` (it may list the same cards), the surface must offer focusing, and the person must be in the
 * page's frame when it asks (they clicked or pressed a key there), so a page can never move the view on its own.
 * Focusing only moves the camera and selects the card: nothing is typed, started or stopped.
 */
export function sessionToFocus<T extends { id: string }>(input: {
  permissions: readonly PluginPermission[];
  sessions: readonly T[];
  sessionId: unknown;
  personInFrame: boolean;
  available: boolean;
}): T {
  if (!input.permissions.includes("sessions:read")) throw new Error("Plugin permission is required: sessions:read.");
  if (!input.available) throw new Error("This plugin surface cannot focus cards.");
  if (!input.personInFrame) throw new Error("sessions.focus answers only an action of the person in this plugin surface.");
  if (typeof input.sessionId !== "string" || !input.sessionId || input.sessionId.length > 200) throw new Error("Plugin request requires sessionId.");
  const session = input.sessions.find((candidate) => candidate.id === input.sessionId);
  if (!session) throw new Error("No open card has this id.");
  return session;
}
