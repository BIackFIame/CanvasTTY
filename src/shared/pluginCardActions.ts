import type { PluginCardActionFilter } from "./contracts.ts";

/** Every key the filter lists must match; a card outside an environment never matches `environmentKinds`. */
export function cardActionMatches(
  when: PluginCardActionFilter | undefined,
  session: { provider: string; role: string; environment?: { kind: string } }
): boolean {
  if (!when) return true;
  if (when.providers && !when.providers.includes(session.provider as never)) return false;
  if (when.roles && !when.roles.includes(session.role as never)) return false;
  if (when.environmentKinds && (!session.environment || !when.environmentKinds.includes(session.environment.kind))) return false;
  return true;
}
