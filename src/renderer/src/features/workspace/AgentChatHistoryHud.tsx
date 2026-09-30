import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentChatHistoryItem, AgentChatHistoryPage, AgentChatHistoryProviderId, AppSettings, SessionSnapshot } from "../../../../shared/contracts";
import { PROVIDER_LABELS } from "../../../../shared/providerCatalog";
import { UiIcon } from "../../components/UiIcon";
import { t } from "../../lib/i18n";

interface AgentChatHistoryHudProps {
  settings: AppSettings;
  sessions: SessionSnapshot[];
  onFocusSession(session: SessionSnapshot): void;
  onResume(item: AgentChatHistoryItem): Promise<void>;
}

type ActivityFilter = "all" | "day" | "week";

interface ChatProjectGroup {
  key: string;
  label: string;
  cwd: string | null;
  items: AgentChatHistoryItem[];
  latestActivityAt: number;
}

const ACTIVITY_WINDOWS: Record<Exclude<ActivityFilter, "all">, number> = {
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000
};

function projectLabel(cwd: string | null, unknownLabel: string): string {
  if (!cwd) return unknownLabel;
  return cwd.split("/").filter(Boolean).at(-1) ?? cwd;
}

export function AgentChatHistoryHud({ settings, sessions, onFocusSession, onResume }: AgentChatHistoryHudProps): React.JSX.Element {
  const [providers, setProviders] = useState<AgentChatHistoryProviderId[]>([]);
  const [provider, setProvider] = useState<AgentChatHistoryProviderId | null>(null);
  const [pages, setPages] = useState<Partial<Record<AgentChatHistoryProviderId, AgentChatHistoryPage>>>({});
  const [collapsed, setCollapsed] = useState(false);
  const [collapsedProjects, setCollapsedProjects] = useState<Map<string, boolean>>(() => new Map());
  const activeProjects = useMemo(() => new Set(sessions.filter((session) => session.exitCode === null).map((session) => session.cwd)), [sessions]);
  const activeHistorySessions = useMemo(() => new Map(
    sessions.filter((session) => session.exitCode === null && session.threadId)
      .map((session) => [`${session.provider}:${session.threadId}`, session] as const)
  ), [sessions]);
  const [query, setQuery] = useState("");
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>("day");
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshRevision, setRefreshRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [resuming, setResuming] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; provider: AgentChatHistoryProviderId; message: string } | null>(null);
  const request = useRef(0);
  const mounted = useRef(true);
  const list = useRef<HTMLDivElement>(null);
  const locale = settings.locale;
  const page = provider ? pages[provider] : undefined;
  const searching = query.trim().length > 0;
  const searchAllAgents = searching && settings.agentChatHistorySearchAgents === "all";
  const visiblePages = useMemo(() => searchAllAgents
    ? providers.flatMap((id) => pages[id] ? [pages[id]!] : [])
    : page ? [page] : [], [searchAllAgents, providers, pages, page]);
  const items = useMemo(() => visiblePages.flatMap((entry) => entry.items), [visiblePages]);
  const isProjectCollapsed = (group: ChatProjectGroup): boolean =>
    collapsedProjects.get(group.key) ?? !activeProjects.has(group.cwd ?? "");
  const groups = useMemo<ChatProjectGroup[]>(() => {
    const cutoff = activityFilter === "all" || (searching && settings.agentChatHistorySearchSessions === "all")
      ? 0 : Date.now() - ACTIVITY_WINDOWS[activityFilter];
    const normalizedQuery = query.trim().toLocaleLowerCase(locale);
    const grouped = new Map<string, ChatProjectGroup>();
    for (const item of items) {
      if (item.lastActivityAt < cutoff) continue;
      if (normalizedQuery && !`${item.title} ${item.cwd ?? ""}`.toLocaleLowerCase(locale).includes(normalizedQuery)) continue;
      const key = item.cwd ?? "__unknown__";
      const current = grouped.get(key);
      if (current) {
        current.items.push(item);
        current.latestActivityAt = Math.max(current.latestActivityAt, item.lastActivityAt);
      } else {
        grouped.set(key, {
          key,
          cwd: item.cwd,
          label: projectLabel(item.cwd, t(locale, "agentChatHistoryUnknownProject")),
          items: [item],
          latestActivityAt: item.lastActivityAt
        });
      }
    }
    return [...grouped.values()]
      .map((group) => ({ ...group, items: [...group.items].sort((a, b) => b.lastActivityAt - a.lastActivityAt) }))
      .sort((a, b) => b.latestActivityAt - a.latestActivityAt || a.label.localeCompare(b.label, locale));
  }, [activityFilter, locale, items, query, searching, settings.agentChatHistorySearchSessions]);

  const changeActivityFilter = (value: ActivityFilter): void => {
    setActivityFilter(value);
    list.current?.scrollTo({ top: 0 });
  };

  const collapseAllProjects = (): void => setCollapsedProjects((current) => {
    const next = new Map(current);
    for (const group of groups) next.set(group.key, true);
    return next;
  });

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; request.current += 1; };
  }, []);

  useEffect(() => {
    let active = true;
    void window.canvasTTY.agentChatHistory.providers().then((next) => {
      if (!active) return;
      setProviders(next);
      setProvider((current) => current && next.includes(current) ? current : next[0] ?? null);
    }).catch(() => { if (active) setError(t(locale, "agentChatHistoryFailed")); });
    return () => { active = false; };
  }, [settings.homeLauncherProviders, locale]);

  const load = useCallback(async (selected: AgentChatHistoryProviderId[]): Promise<void> => {
    const revision = ++request.current;
    setLoading(true);
    setError(null);
    try {
      const results = await Promise.all(selected.map(async (id): Promise<AgentChatHistoryPage | null> => {
        try {
          let next = await window.canvasTTY.agentChatHistory.list(id);
          const collected = [...next.items];
          while (!next.error && next.nextCursor) {
            if (!mounted.current || revision !== request.current) return null;
            next = await window.canvasTTY.agentChatHistory.list(id, next.nextCursor);
            collected.push(...next.items);
          }
          return { ...next, items: collected, nextCursor: null };
        } catch {
          return { provider: id, items: [], nextCursor: null, error: t(locale, "agentChatHistoryFailed") };
        }
      }));
      if (!mounted.current || revision !== request.current) return;
      setPages((current) => ({
        ...current,
        ...Object.fromEntries(results.filter((entry) => entry !== null).map((entry) => [entry.provider, entry]))
      }));
    } catch {
      if (mounted.current && revision === request.current) setError(t(locale, "agentChatHistoryFailed"));
    } finally {
      if (mounted.current && revision === request.current) { setLoading(false); setRefreshing(false); }
    }
  }, [locale]);

  useEffect(() => {
    request.current += 1;
    setRowError(null);
    setError(null);
    if (provider) void load(searchAllAgents ? providers : [provider]);
    else { setLoading(false); setRefreshing(false); }
    return () => { request.current += 1; };
  }, [provider, providers, searchAllAgents, load, refreshRevision]);

  useEffect(() => {
    const collapse = (): void => setCollapsed(true);
    window.addEventListener("canvastty:terminal-input", collapse);
    return () => window.removeEventListener("canvastty:terminal-input", collapse);
  }, []);

  const resume = async (item: AgentChatHistoryItem): Promise<void> => {
    setResuming(item.id);
    setRowError(null);
    try { await onResume(item); }
    catch (failure) {
      if (mounted.current) setRowError({ id: item.id, provider: item.provider, message: failure instanceof Error ? failure.message : t(locale, "agentChatHistoryFailed") });
    } finally { if (mounted.current) setResuming(null); }
  };

  const refresh = async (): Promise<void> => {
    const revision = ++request.current;
    setRefreshing(true);
    setLoading(true);
    setError(null);
    setRowError(null);
    try {
      const next = await window.canvasTTY.agentChatHistory.providers();
      if (!mounted.current || revision !== request.current) return;
      setProviders(next);
      if (!provider || !next.includes(provider)) setProvider(next[0] ?? null);
      setRefreshRevision((current) => current + 1);
    } catch {
      if (mounted.current && revision === request.current) {
        setError(t(locale, "agentChatHistoryFailed"));
        setLoading(false);
        setRefreshing(false);
      }
    }
  };

  return (
    <section className="agent-chat-history" aria-label={t(locale, "agentChatHistory")}
      data-canvas-widget-id="agent-chat-history" data-canvas-widget-focusable="false"
      onPointerEnter={() => { if (settings.agentChatHistoryExpandMode === "hover") setCollapsed(false); }}
      onClick={(event) => {
        if (!(event.target as HTMLElement).closest("button, input, select")) setCollapsed(false);
      }}
      data-interactive="true" data-wheel-owner="local" data-canvas-wheel-priority="local">
      <header className="agent-chat-history__header">
        <button className="agent-chat-history__title" type="button" onClick={() => setCollapsed((current) => !current)}
          aria-expanded={!collapsed} aria-controls="agent-chat-history-body">
          <strong>{t(locale, "agentChatHistory")}</strong>
        </button>
        <div className="agent-chat-history__actions">
          <button type="button" disabled={refreshing || resuming !== null} onClick={() => void refresh()}
            title={t(locale, "agentChatHistoryRefresh")} aria-label={t(locale, "agentChatHistoryRefresh")}>
            <UiIcon name={refreshing ? "working" : "reload"} size="1.23em" />
          </button>
          <button type="button" disabled={groups.length === 0} onClick={collapseAllProjects}
            title={t(locale, "agentChatHistoryCollapseAll")} aria-label={t(locale, "agentChatHistoryCollapseAll")}>
            <UiIcon name="minus" size="1.23em" />
          </button>
        </div>
      </header>
      <div className="agent-chat-history__body" id="agent-chat-history-body" hidden={collapsed}>
        <div className="agent-chat-history__filters">
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)}
            placeholder={t(locale, "agentChatHistorySearchPlaceholder")} aria-label={t(locale, "agentChatHistorySearch")} />
          <select value={activityFilter}
            onInput={(event) => changeActivityFilter(event.currentTarget.value as ActivityFilter)}
            onChange={(event) => changeActivityFilter(event.target.value as ActivityFilter)}
            aria-label={t(locale, "agentChatHistoryActivity")}>
            <option value="day">{t(locale, "agentChatHistoryActivityDay")}</option>
            <option value="week">{t(locale, "agentChatHistoryActivityWeek")}</option>
            <option value="all">{t(locale, "agentChatHistoryActivityAll")}</option>
          </select>
        </div>
        <div className="agent-chat-history__tabs" role="tablist" aria-label={t(locale, "agentChatHistory")}>
          {providers.map((id) => (
            <button key={id} id={`agent-chat-history-tab-${id}`} type="button" role="tab" aria-selected={provider === id}
              aria-controls="agent-chat-history-list" onClick={() => setProvider(id)}>{PROVIDER_LABELS[id]}</button>
          ))}
        </div>
        <div className="agent-chat-history__list" ref={list} id="agent-chat-history-list" role="tabpanel"
          aria-labelledby={provider ? `agent-chat-history-tab-${provider}` : undefined} aria-busy={loading} tabIndex={0}>
          {providers.length === 0 && !error && <p>{t(locale, "agentChatHistoryNoProviders")}</p>}
          {error && <p className="agent-chat-history__error" role="alert">{error}</p>}
          {visiblePages.map((entry) => (
            <div key={entry.provider}>
              {entry.error && <p className="agent-chat-history__error" role="alert">{PROVIDER_LABELS[entry.provider]}: {entry.error}</p>}
              {entry.warning && <p role="status">{PROVIDER_LABELS[entry.provider]}: {entry.warning}</p>}
            </div>
          ))}
          {visiblePages.length > 0 && groups.length === 0 && !error && !loading && !visiblePages.some((entry) => entry.error)
            && <p>{t(locale, searching || items.length > 0 ? "agentChatHistoryNoMatches" : "agentChatHistoryEmpty")}</p>}
          {groups.map((group) => (
            <section className="agent-chat-history__project" key={group.key}>
              <button type="button" className="agent-chat-history__project-toggle"
                aria-expanded={!isProjectCollapsed(group)} title={group.cwd ?? undefined}
                onClick={() => setCollapsedProjects((current) => {
                  const next = new Map(current);
                  next.set(group.key, !isProjectCollapsed(group));
                  return next;
                })}>
                <UiIcon name={isProjectCollapsed(group) ? "plus" : "minus"} size="1em" />
                <strong>{group.label}</strong><small>{group.items.length}</small>
              </button>
              {group.items.map((item) => {
                const activeSession = activeHistorySessions.get(`${item.provider}:${item.id}`);
                if (isProjectCollapsed(group) && !activeSession) return null;
                const working = activeSession?.status === "working";
                return (
                <div key={`${item.provider}:${item.id}`}>
                  <button type="button" className={`agent-chat-history__item${activeSession ? " is-active" : ""}`} disabled={resuming !== null}
                    title={`${t(locale, activeSession ? "agentChatHistoryFocus" : "agentChatHistoryResume")} · ${item.id}`}
                    onClick={() => activeSession ? onFocusSession(activeSession) : void resume(item)}>
                    <strong>{item.title}</strong>
                    {searchAllAgents && <span>{PROVIDER_LABELS[item.provider]}</span>}
                    {activeSession && <span className="agent-chat-history__active">{t(locale, working ? "agentChatHistoryWorking" : "agentChatHistoryOpen")}</span>}
                    <time dateTime={new Date(item.lastActivityAt).toISOString()}>{new Date(item.lastActivityAt).toLocaleString(locale)}</time>
                    <span title={item.cwd ?? undefined}>{item.cwd ?? t(locale, "agentChatHistoryUnknownDirectory")}</span>
                  </button>
                  {rowError?.id === item.id && rowError.provider === item.provider && <p className="agent-chat-history__error" role="alert">{rowError.message}</p>}
                </div>
                );
              })}
            </section>
          ))}
        </div>
      </div>
    </section>
  );
}
