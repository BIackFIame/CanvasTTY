import { useEffect, useRef, useState } from "react";
import type { LocaleId, ProviderSecretId } from "../../../../shared/contracts";
import { PROVIDER_SECRET_IDS } from "../../../../shared/contracts";
import { t } from "../../lib/i18n";

const SECRET_LABELS: Record<ProviderSecretId, string> = {
  OPENAI_API_KEY: "OpenAI",
  ANTHROPIC_API_KEY: "Anthropic",
  XAI_API_KEY: "xAI",
  GOOGLE_API_KEY: "Google",
  ZAI_API_KEY: "Z.AI",
  MINIMAX_API_KEY: "MiniMax",
  OPENROUTER_API_KEY: "OpenRouter",
  DEEPSEEK_API_KEY: "DeepSeek",
  DEVIN_API_KEY: "Devin",
  CURSOR_API_KEY: "Cursor"
};

interface ProviderSecretsSettingsProps {
  locale: LocaleId;
}

export function ProviderSecretsSettings({ locale }: ProviderSecretsSettingsProps): React.JSX.Element {
  const [status, setStatus] = useState<Record<ProviderSecretId, boolean>>(
    () => Object.fromEntries(PROVIDER_SECRET_IDS.map((secretId) => [secretId, false])) as Record<ProviderSecretId, boolean>
  );
  const [drafts, setDrafts] = useState<Partial<Record<ProviderSecretId, string>>>({});
  const [busy, setBusy] = useState<Partial<Record<ProviderSecretId, boolean>>>({});
  const [error, setError] = useState<string | null>(null);
  // Saves in flight, read synchronously: Enter and a click can both arrive before React re-renders
  // with the busy state, and a second write of the same key must not start meanwhile.
  const inFlight = useRef(new Set<ProviderSecretId>());

  useEffect(() => {
    window.canvasTTY.providerSecrets.status().then(setStatus, () => undefined);
  }, []);

  const run = async (secretId: ProviderSecretId, submitted: string, action: () => Promise<void>, configured: boolean): Promise<void> => {
    if (inFlight.current.has(secretId)) return;
    inFlight.current.add(secretId);
    setBusy((current) => ({ ...current, [secretId]: true }));
    setError(null);
    try {
      await action();
      setStatus((current) => ({ ...current, [secretId]: configured }));
      // Clear only what was submitted. Anything typed while the request ran is a new draft.
      setDrafts((current) => ((current[secretId] ?? "") === submitted ? { ...current, [secretId]: "" } : current));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      inFlight.current.delete(secretId);
      setBusy((current) => ({ ...current, [secretId]: false }));
    }
  };

  const save = async (secretId: ProviderSecretId): Promise<void> => {
    const submitted = drafts[secretId] ?? "";
    const value = submitted.trim();
    if (value.length === 0) return;
    await run(secretId, submitted, () => window.canvasTTY.providerSecrets.set(secretId, value), true);
  };

  const clear = async (secretId: ProviderSecretId): Promise<void> => {
    await run(secretId, drafts[secretId] ?? "", () => window.canvasTTY.providerSecrets.clear(secretId), false);
  };

  return (
    <div className="agent-launcher-settings">
      {PROVIDER_SECRET_IDS.map((secretId) => {
        const configured = status[secretId];
        const draft = drafts[secretId] ?? "";
        return (
          <div className="agent-launcher-settings__row provider-secret-row" key={secretId}>
            <span className="agent-launcher-settings__identity">
              <strong>{SECRET_LABELS[secretId]}</strong>
              <span className={configured ? "provider-secret provider-secret--on" : "provider-secret"}>
                {configured ? t(locale, "providerSecretConfigured") : t(locale, "providerSecretNotConfigured")}
              </span>
            </span>
            <span className="provider-secret__controls">
              <input
                className="provider-secret__input"
                type="password"
                value={draft}
                autoComplete="off"
                spellCheck={false}
                placeholder={secretId}
                aria-label={`${SECRET_LABELS[secretId]} ${secretId}`}
                onChange={(event) => {
                  // Read the value while the event is dispatching: React may run the updater
                  // later (a paste over a pending edit), when currentTarget is already null.
                  const value = event.currentTarget.value;
                  setDrafts((current) => ({ ...current, [secretId]: value }));
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void save(secretId);
                }}
              />
              <button
                type="button"
                disabled={busy[secretId] === true || draft.trim().length === 0}
                onClick={() => void save(secretId)}
              >{t(locale, "providerSecretSave")}</button>
              {configured && (
                <button
                  type="button"
                  disabled={busy[secretId] === true}
                  onClick={() => void clear(secretId)}
                >{t(locale, "providerSecretClear")}</button>
              )}
            </span>
          </div>
        );
      })}
      {error && <p className="settings-error" role="alert">{error}</p>}
    </div>
  );
}
