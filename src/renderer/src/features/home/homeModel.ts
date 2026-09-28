import type {
  LimitUnavailableReason,
  LimitProviderId,
  LimitWindow,
  LimitsSnapshot,
  LocaleId,
  SessionSnapshot
} from "../../../../shared/contracts";
import { LIMIT_PROVIDERS } from "../../../../shared/contracts.ts";

const DEFAULT_LIMIT_PROVIDERS = LIMIT_PROVIDERS;

export type LimitsLoadState = "loading" | "ready" | "error";
export type HomeLimitReason = LimitUnavailableReason | "percentage-unavailable" | "reset-unavailable" | "refresh-error";

export interface HomeLimitRow {
  provider: LimitProviderId;
  state: "loading" | "available" | "stale" | "unavailable" | "error";
  window: HomeLimitWindow | null;
  reason: HomeLimitReason | null;
}

export interface HomeLimitWindow {
  id: string;
  windowMinutes: number;
  usedPercent: number;
  resetsAt: number;
}

export interface HomeModel {
  limitRows: HomeLimitRow[];
  sessionRows: SessionSnapshot[];
}

export function selectHomeModel(
  sessions: readonly SessionSnapshot[],
  limits: LimitsSnapshot | null,
  limitsLoadState: LimitsLoadState,
  currentTime = Date.now(),
  limitProviders: readonly LimitProviderId[] = DEFAULT_LIMIT_PROVIDERS
): HomeModel {
  const newestFirst = [...sessions].sort((left, right) => right.startedAt - left.startedAt);
  const selectedLimitProviders = new Set(limitProviders);

  return {
    limitRows: DEFAULT_LIMIT_PROVIDERS
      .filter((provider) => selectedLimitProviders.has(provider))
      .map((provider) => selectProviderLimit(provider, limits, limitsLoadState, currentTime)),
    sessionRows: newestFirst
  };
}

export function formatLimitDuration(totalMinutes: number, locale: LocaleId): string {
  const daySuffix = locale === "ru" ? "д" : "d";
  const hourSuffix = locale === "ru" ? "ч" : "h";
  const minuteSuffix = locale === "ru" ? "м" : "m";
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];

  if (days > 0) parts.push(`${days} ${daySuffix}`);
  if (hours > 0) parts.push(`${hours} ${hourSuffix}`);
  if (minutes > 0 || parts.length === 0) parts.push(`${minutes} ${minuteSuffix}`);
  return parts.join(" ");
}

export function formatResetCountdown(resetsAt: number, currentTime: number, locale: LocaleId): string {
  const totalMinutes = Math.ceil((resetsAt - currentTime) / 60_000);
  if (totalMinutes <= 0) return locale === "ru" ? "Сброс" : "Reset";

  const totalHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (totalMinutes < 1_440) {
    return `${String(totalHours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
  }

  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return locale === "ru"
    ? `${days}д ${String(hours).padStart(2, "0")}ч`
    : `${days}d ${String(hours).padStart(2, "0")}h`;
}

function selectProviderLimit(
  provider: LimitProviderId,
  snapshot: LimitsSnapshot | null,
  loadState: LimitsLoadState,
  currentTime: number
): HomeLimitRow {
  if (!snapshot) {
    return {
      provider,
      state: loadState === "loading" ? "loading" : "error",
      window: null,
      reason: loadState === "loading" ? null : "refresh-error"
    };
  }

  const providerSnapshot = snapshot.providers.find((entry) => entry.provider === provider);
  if (!providerSnapshot) {
    return {
      provider,
      state: "error",
      window: null,
      reason: "refresh-error"
    };
  }

  if (providerSnapshot.state === "unavailable") {
    return {
      provider,
      state: "unavailable",
      window: null,
      reason: providerSnapshot.reason
    };
  }

  const window = selectPreferredWindow(providerSnapshot.windows, currentTime);
  const refreshFailed = loadState === "error";
  if (!window) {
    const hasDefaultUsage = providerSnapshot.windows.some((candidate) => (
      candidate.isDefaultBucket
      && candidate.usedPercent !== null
      && Number.isFinite(candidate.usedPercent)
    ));
    return {
      provider,
      state: providerSnapshot.state === "stale" || refreshFailed ? "stale" : "unavailable",
      window: null,
      reason: providerSnapshot.state === "stale"
        ? providerSnapshot.reason
        : refreshFailed
          ? "refresh-error"
          : hasDefaultUsage
            ? "reset-unavailable"
            : "percentage-unavailable"
    };
  }

  return {
    provider,
    state: providerSnapshot.state === "stale" || refreshFailed ? "stale" : "available",
    window,
    reason: providerSnapshot.state === "stale"
      ? providerSnapshot.reason
      : refreshFailed
        ? "refresh-error"
        : null
  };
}

function selectPreferredWindow(windows: readonly LimitWindow[], currentTime: number): HomeLimitWindow | null {
  const candidates = windows
    .filter((window) => (
      window.isDefaultBucket
      && window.windowMinutes !== null
      && Number.isFinite(window.windowMinutes)
      && window.windowMinutes > 0
      && window.usedPercent !== null
      && Number.isFinite(window.usedPercent)
      && window.resetsAt !== null
      && Number.isFinite(window.resetsAt)
    ));
  const future = candidates.filter((window) => window.resetsAt! > currentTime);
  const selected = (future.length > 0 ? future : candidates)
    .sort((left, right) => (
      right.windowMinutes! - left.windowMinutes!
      || left.resetsAt! - right.resetsAt!
    ))[0];
  if (!selected) return null;

  return {
    id: selected.id,
    windowMinutes: selected.windowMinutes!,
    usedPercent: clampPercent(selected.usedPercent!),
    resetsAt: selected.resetsAt!
  };
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}
