import { useEffect, useState } from "react";
import type { LocaleId, PluginBrokerAccount, PluginBrokerAccounts } from "../../../../shared/contracts";
import { brokerText } from "./brokerText";
import { t } from "../../lib/i18n";

interface PluginBrokerGrantsProps {
  locale: LocaleId;
  ownerId: string;
  /** Changes when the plugin list changes (trust, enable): the offer is asked again. */
  refreshKey: string;
  busy: boolean;
  onError(message: string | null): void;
}

/**
 * Under an owner (a plugin whose service offers accounts) in Settings -> Agents -> Extension native code: each offered
 * account with one switch per plugin that may ask for it. Switching on asks first and shows where requests go.
 */
export function PluginBrokerGrants({ locale, ownerId, refreshKey, busy, onError }: PluginBrokerGrantsProps): React.JSX.Element | null {
  const [state, setState] = useState<PluginBrokerAccounts | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void window.canvasTTY.plugins.brokerAccounts(ownerId).then(
      (next) => { if (!cancelled) setState(next); },
      () => { if (!cancelled) setState({ available: false, accounts: [], callers: [], grants: [], allGrants: [] }); }
    );
    return () => { cancelled = true; };
  }, [ownerId, refreshKey]);

  if (!state || state.callers.length === 0) return null;

  const setGrant = async (callerId: string, account: Pick<PluginBrokerAccount, "id">, granted: boolean): Promise<void> => {
    setSaving(true);
    onError(null);
    try {
      setState(await window.canvasTTY.plugins.setBrokerGrant(callerId, ownerId, account.id, granted));
      setConfirming(null);
    } catch {
      onError(t(locale, "pluginHookChangeFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="plugin-broker-grants">
      <span className="agent-hooks__copy">
        <strong>{brokerText(locale, "title")}</strong>
        <small>{brokerText(locale, "description")}</small>
      </span>
      {!state.available && <small>{brokerText(locale, "unavailable")}</small>}
      {state.available && state.callers.map((caller) => {
        // The all-accounts grant (one switch per caller): new accounts on allowed addresses are covered.
        const key = `${caller.pluginId} *`;
        const all = state.allGrants?.find((entry) => entry.caller === caller.pluginId);
        const on = all?.state === "on";
        const waiting = on && state.grants.some((entry) => entry.caller === caller.pluginId && entry.state === "new-address");
        const note = all?.state === "changed" ? brokerText(locale, "allChanged") : !caller.ready ? brokerText(locale, "callerOff") : null;
        const origins = [...new Set(state.accounts.map((account) => account.origin))];
        return (
          <div key={key}>
            <div className="agent-hooks__row-main">
              <span className="agent-hooks__copy">
                <strong>{brokerText(locale, "allTitle")} · {caller.name}</strong>
                <small>{brokerText(locale, "allDescription")}{note ? ` · ${note}` : ""}</small>
              </span>
              <button
                className={`agent-hooks__toggle${on ? " agent-hooks__toggle--on" : ""}`}
                type="button"
                role="switch"
                aria-checked={on}
                aria-label={`${brokerText(locale, "allTitle")}: ${caller.name}`}
                disabled={busy || saving || (!on && !caller.ready)}
                onClick={() => {
                  if (on) void setGrant(caller.pluginId, { id: "*" }, false);
                  else setConfirming(key);
                }}
              >
                <span aria-hidden="true" />
                {t(locale, on ? "on" : "off")}
              </button>
            </div>
            {waiting && confirming !== key && (
              <div className="agent-hooks__confirm">
                <p>{brokerText(locale, "newAddress")}</p>
                <div>
                  <button type="button" disabled={busy || saving || !caller.ready} onClick={() => setConfirming(key)}>
                    {brokerText(locale, "allowNewAddress")}
                  </button>
                </div>
              </div>
            )}
            {confirming === key && (
              <div className="agent-hooks__confirm">
                <p>{brokerText(locale, "allConfirm")}</p>
                <p>
                  <strong>{caller.name}</strong> → {brokerText(locale, "allAddresses")}{" "}
                  {origins.length ? origins.map((origin) => <code key={origin}>{origin} </code>) : brokerText(locale, "allNone")}
                </p>
                <div>
                  <button type="button" onClick={() => setConfirming(null)}>{t(locale, "cancel")}</button>
                  <button
                    className="agent-hooks__trust"
                    type="button"
                    disabled={busy || saving}
                    onClick={() => void setGrant(caller.pluginId, { id: "*" }, true)}
                  >{brokerText(locale, "allow")}</button>
                </div>
              </div>
            )}
          </div>
        );
      })}
      {state.available && state.accounts.length === 0 && <small>{brokerText(locale, "none")}</small>}
      {state.accounts.map((account) => (
        <div key={account.id}>
          <span className="agent-hooks__copy">
            <strong>{account.label}{account.flatRate ? ` · ${brokerText(locale, "flatRate")}` : ""}</strong>
            <small>
              {brokerText(locale, "origin")} <code>{account.origin}</code> · {account.protocol}
              {" · "}{brokerText(locale, "models")} {account.models.join(", ")}
            </small>
          </span>
          {state.callers.map((caller) => {
            const key = `${caller.pluginId} ${account.id}`;
            const grant = state.grants.find((entry) => entry.caller === caller.pluginId && entry.account === account.id);
            const granted = grant?.state === "granted";
            const covered = state.allGrants?.some((entry) => entry.caller === caller.pluginId && entry.state === "on") === true;
            const note = grant?.state === "changed" ? brokerText(locale, "changed")
              : grant?.state === "new-address" ? brokerText(locale, "newAddress")
                : granted && covered ? brokerText(locale, "covered")
                  : !caller.ready ? brokerText(locale, "callerOff") : null;
            return (
              <div key={key}>
                <div className="agent-hooks__row-main">
                  <span className="agent-hooks__copy">
                    <strong>{caller.name}</strong>
                    {note && <small>{note}</small>}
                  </span>
                  <button
                    className={`agent-hooks__toggle${granted ? " agent-hooks__toggle--on" : ""}`}
                    type="button"
                    role="switch"
                    aria-checked={granted}
                    aria-label={`${brokerText(locale, "title")}: ${caller.name} · ${account.label}`}
                    disabled={busy || saving || (!granted && !caller.ready) || (granted && covered)}
                    onClick={() => {
                      if (granted) void setGrant(caller.pluginId, account, false);
                      else setConfirming(key);
                    }}
                  >
                    <span aria-hidden="true" />
                    {t(locale, granted ? "on" : "off")}
                  </button>
                </div>
                {confirming === key && (
                  <div className="agent-hooks__confirm">
                    <p>{brokerText(locale, "confirm")}</p>
                    <p>
                      <strong>{caller.name}</strong> → <strong>{account.label}</strong> · <code>{account.origin}</code> · {account.models.join(", ")}
                    </p>
                    <div>
                      <button type="button" onClick={() => setConfirming(null)}>{t(locale, "cancel")}</button>
                      <button
                        className="agent-hooks__trust"
                        type="button"
                        disabled={busy || saving}
                        onClick={() => void setGrant(caller.pluginId, account, true)}
                      >{brokerText(locale, "allow")}</button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
