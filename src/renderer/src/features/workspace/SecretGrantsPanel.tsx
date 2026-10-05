import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LocaleId, ProviderSecretId, SessionSnapshot } from "../../../../shared/contracts";
import type { SecretGrant, SecretGrantDuration, SecretGrantRequest } from "../../../../shared/backlog";
import { backlogApi } from "./backlogRendererApi";
import { useVisibleRefresh } from "./visibleRefresh";

interface SecretGrantsPanelProps {
  sessionId: string;
  sessions: readonly SessionSnapshot[];
  locale: LocaleId;
  onError(message: string): void;
}

export function SecretGrantsPanel({ sessionId, sessions, locale, onError }: SecretGrantsPanelProps): React.JSX.Element {
  const api = useMemo(() => backlogApi(), []);
  const [requests, setRequests] = useState<SecretGrantRequest[]>([]);
  const [grants, setGrants] = useState<SecretGrant[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const mounted = useRef(true);
  const refreshInFlight = useRef(false);
  const text = locale === "ru" ? {
    title: "Доступ к ключам провайдеров", note: "Ключи используются только для изолированных запросов к API выбранного профиля. Они не показываются и не вставляются в сообщения.",
    pending: "Ожидают решения", grants: "Разрешения", noRequests: "Запросов на доступ нет.", noGrants: "Активных разрешений нет.",
    reason: "Причина", session: "Карточка", approve10m: "10 минут", approveTurn: "До конца хода", approveSession: "До закрытия карточки",
    deny: "Отклонить", revoke: "Отозвать", approved: "Доступ разрешён", expires: "Истекает", turn: "до конца хода", sessionGrant: "до закрытия карточки",
    expired: "истёк", loading: "Загрузка…", refresh: "Обновить"
  } : {
    title: "Provider secret access", note: "Keys are used only for isolated API requests to a selected profile. Values are never shown or pasted into messages.",
    pending: "Pending requests", grants: "Active grants", noRequests: "No access requests.", noGrants: "No active grants.",
    reason: "Reason", session: "Card", approve10m: "10 minutes", approveTurn: "Until this turn ends", approveSession: "Until card closes",
    deny: "Deny", revoke: "Revoke", approved: "Access approved", expires: "Expires", turn: "until turn ends", sessionGrant: "until card closes",
    expired: "expired", loading: "Loading…", refresh: "Refresh"
  };

  const refresh = useCallback(async (): Promise<void> => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    try {
      const [nextRequests, nextGrants] = await Promise.all([api.secretRequests(sessionId), api.secretGrants(sessionId)]);
      if (mounted.current) { setRequests(nextRequests); setGrants(nextGrants); }
    } finally {
      refreshInFlight.current = false;
    }
  }, [api, sessionId]);

  const refreshSafely = useCallback(async (): Promise<void> => {
    if (!mounted.current || document.hidden || refreshInFlight.current) return;
    setLoading(true);
    try {
      await refresh();
      if (mounted.current) setError("");
    } catch (reason) {
      if (!mounted.current) return;
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(message);
      onError(message);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [onError, refresh]);

  useEffect(() => {
    mounted.current = true;
    void refreshSafely();
    return () => { mounted.current = false; };
  }, [refreshSafely]);
  useVisibleRefresh(() => { void refreshSafely(); }, 5_000);

  const runGrantChange = async (key: string, action: () => Promise<unknown>): Promise<void> => {
    setBusyId(key); setError("");
    try {
      await action();
      await refresh();
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(message); onError(message);
    } finally { setBusyId(""); }
  };

  const decide = (request: SecretGrantRequest, duration: SecretGrantDuration | null): Promise<void> =>
    runGrantChange(request.id, () => duration
      ? api.approveSecretRequest(sessionId, request.id, duration)
      : api.denySecretRequest(sessionId, request.id));

  const revoke = (grant: SecretGrant): Promise<void> => runGrantChange(`${grant.sessionId}:${grant.secretId}`,
    () => api.revokeSecretGrant(sessionId, grant.sessionId, grant.secretId as ProviderSecretId));

  const memberTitle = (id: string): string => sessions.find((candidate) => candidate.id === id)?.title ?? id;
  const durationText = (grant: SecretGrant): string => grant.duration === "10m" ? `${text.expires} ${new Date(grant.expiresAt ?? 0).toLocaleTimeString(locale)}`
    : grant.duration === "turn" ? text.turn : text.sessionGrant;

  return <section className="backlog-secret-grants">
    <header><h3>{text.title}</h3><button type="button" disabled={loading} onClick={() => void refreshSafely()}>{text.refresh}</button></header>
    <p className="backlog-secret-grants__note">{text.note}</p>
    {error && <p className="backlog-inspector__error" role="alert">{error}</p>}
    {loading && requests.length === 0 && grants.length === 0 && <p role="status">{text.loading}</p>}
    <section><h4>{text.pending}</h4>
      {requests.length === 0 ? <p className="backlog-inspector__empty">{text.noRequests}</p> : <ol className="backlog-secret-grants__list">
        {requests.map((request) => <li key={request.id}>
          <div className="backlog-secret-grants__request"><strong>{request.secretId}</strong><small>{text.session}: {memberTitle(request.sessionId)}</small>
            <p>{text.reason}: {request.reason}</p><time>{new Date(request.createdAt).toLocaleString(locale)}</time></div>
          <div className="backlog-secret-grants__actions">
            <button type="button" disabled={busyId === request.id} onClick={() => void decide(request, "10m")}>{text.approve10m}</button>
            <button type="button" disabled={busyId === request.id} onClick={() => void decide(request, "turn")}>{text.approveTurn}</button>
            <button type="button" disabled={busyId === request.id} onClick={() => void decide(request, "session")}>{text.approveSession}</button>
            <button type="button" disabled={busyId === request.id} onClick={() => void decide(request, null)}>{text.deny}</button>
          </div>
        </li>)}
      </ol>}
    </section>
    <section><h4>{text.grants}</h4>
      {grants.length === 0 ? <p className="backlog-inspector__empty">{text.noGrants}</p> : <ul className="backlog-secret-grants__list">
        {grants.map((grant) => {
          const key = `${grant.sessionId}:${grant.secretId}`;
          return <li key={key}>
            <div><strong>{grant.secretId}</strong><small>{text.session}: {memberTitle(grant.sessionId)} · {durationText(grant)}</small>
              <time>{text.approved}: {new Date(grant.approvedAt).toLocaleString(locale)}</time></div>
            <button type="button" disabled={busyId === key} onClick={() => void revoke(grant)}>{text.revoke}</button>
          </li>;
        })}
      </ul>}
    </section>
  </section>;
}
