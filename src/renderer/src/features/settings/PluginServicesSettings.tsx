import { useEffect, useState } from "react";
import type {
  InstalledPlugin,
  LocaleId,
  PluginServiceReport,
  PluginSharedReadStatus,
  PluginServiceState
} from "../../../../shared/contracts";
import { sharedReadText } from "./sharedReadText";
import { t, type TranslationKey } from "../../lib/i18n";
import { pluginName } from "../../../../shared/pluginLocalizedText.ts";
import { pollWhileOpen } from "./settingsPolling";
import { PluginBrokerGrants } from "./PluginBrokerGrants";

interface PluginServicesSettingsProps {
  locale: LocaleId;
  plugins: InstalledPlugin[];
  open?: boolean;
  onSetNativeCodeTrusted(pluginId: string, trusted: boolean): Promise<void>;
  onSetDecisionsMayAllow(pluginId: string, allowed: boolean): Promise<void>;
  onSetMayStartOrchestrators(pluginId: string, allowed: boolean): Promise<void>;
  onSetSharedReadApproved?(pluginId: string, provider: string, method: string, approved: boolean): Promise<void>;
  onSetTrustUpdates?(pluginId: string, trusted: boolean): Promise<void>;
}

/** "Trust updates from this repository" (C3): settings-only text, kept in this lazily loaded chunk. */
const UPDATE_TRUST_TEXT = {
  ru: {
    title: "Доверять обновлениям из",
    description: "Пока обновления не просят новых прав, после обновления ничего не нужно включать заново. Выключено по умолчанию.",
    risk: "Если кто-то получит доступ к этому репозиторию, его код запустится у вас при следующем обновлении.",
    enable: "Доверять обновлениям",
    kept: "Обновлено {from} → {to}, доверие сохранено.",
    revoke: "Отозвать"
  },
  en: {
    title: "Trust updates from",
    description: "While updates ask for no new permissions, nothing has to be turned on again after an update. Off by default.",
    risk: "If someone gets access to this repository, their code runs on your computer at the next update.",
    enable: "Trust updates",
    kept: "Updated {from} → {to}, trust kept.",
    revoke: "Revoke"
  }
} as const;

/** `owner/repo` of a GitHub source, or the source itself. */
export function repositoryLabel(sourceUrl: string): string {
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/iu.exec(sourceUrl);
  return match ? match[1] : sourceUrl;
}

/** The orchestrator consent's text lives with this lazily loaded settings chunk, not in the startup bundle. */
const ORCHESTRATOR_TEXT = {
  ru: {
    title: "Может запускать оркестраторов",
    description: "Без этого расширение запускает только обычные окна агентов.",
    confirm: "Расширение сможет открывать окна оркестраторов, которые сами запускают субагентов, на выбранных им CLI, папке и среде. Окно помечено как запущенное расширением, YOLO недоступен; базовая защита, изоляция и ваши правила запуска действуют.",
    enable: "Разрешить"
  },
  en: {
    title: "May start orchestrators",
    description: "Without this the extension starts only plain agent cards.",
    confirm: "The extension can open orchestrator cards, which start subagents of their own, on the CLI, folder and environment it chooses. The card is marked as started by the extension and never gets YOLO; base protection, isolation and your launch rules still apply.",
    enable: "Let it start"
  }
} as const;

/**
 * "Native code": the separate trust confirmation for plugin services. Installing a plugin never
 * runs its services; each plugin's services start only after this confirmation, and an update,
 * a module change or disabling the plugin revokes it.
 */
export function PluginServicesSettings({
  locale,
  plugins,
  open = true,
  onSetNativeCodeTrusted,
  onSetDecisionsMayAllow,
  onSetMayStartOrchestrators,
  onSetSharedReadApproved,
  onSetTrustUpdates
}: PluginServicesSettingsProps): React.JSX.Element | null {
  const rows = plugins.filter((plugin) => plugin.manifest.services?.length);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reports, setReports] = useState<Record<string, PluginServiceReport>>({});
  const trustedKey = rows.map((plugin) => `${plugin.manifest.id}:${plugin.nativeCodeTrusted}`).join(",");
  // Any plugin's trust or enabled state can change who may ask for an owner's accounts.
  const brokerKey = plugins.map((plugin) => `${plugin.manifest.id}:${plugin.enabled}:${plugin.nativeCodeTrusted}:${plugin.manifest.version}`).join(",");

  useEffect(() => {
    let cancelled = false;
    const stop = pollWhileOpen(open, 3_000, async () => {
      const entries = await Promise.all(rows.map(async (plugin) => (
        [plugin.manifest.id, await window.canvasTTY.plugins.serviceReport(plugin.manifest.id)] as const
      )));
      if (!cancelled) setReports(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
      stop();
    };
    // Rows are derived from plugins; the key captures what changes the report.
  }, [trustedKey, open]);

  if (rows.length === 0) return null;

  const setTrusted = async (plugin: InstalledPlugin, trusted: boolean): Promise<void> => {
    setBusy(plugin.manifest.id);
    setError(null);
    try {
      await onSetNativeCodeTrusted(plugin.manifest.id, trusted);
      setConfirming(null);
    } catch {
      setError(t(locale, "pluginHookChangeFailed"));
    } finally {
      setBusy(null);
    }
  };

  const setMayAllow = async (plugin: InstalledPlugin, allowed: boolean): Promise<void> => {
    setBusy(plugin.manifest.id);
    setError(null);
    try {
      await onSetDecisionsMayAllow(plugin.manifest.id, allowed);
      setConfirming(null);
    } catch {
      setError(t(locale, "pluginHookChangeFailed"));
    } finally {
      setBusy(null);
    }
  };

  const orchestratorText = ORCHESTRATOR_TEXT[locale === "ru" ? "ru" : "en"];
  const updateTrustText = UPDATE_TRUST_TEXT[locale === "ru" ? "ru" : "en"];
  const setTrustUpdates = async (plugin: InstalledPlugin, trustedUpdates: boolean): Promise<void> => {
    if (!onSetTrustUpdates) return;
    setBusy(plugin.manifest.id);
    setError(null);
    try {
      await onSetTrustUpdates(plugin.manifest.id, trustedUpdates);
      setConfirming(null);
    } catch {
      setError(t(locale, "pluginHookChangeFailed"));
    } finally {
      setBusy(null);
    }
  };
  const setMayStartOrchestrators = async (plugin: InstalledPlugin, allowed: boolean): Promise<void> => {
    setBusy(plugin.manifest.id);
    setError(null);
    try {
      await onSetMayStartOrchestrators(plugin.manifest.id, allowed);
      setConfirming(null);
    } catch {
      setError(t(locale, "pluginHookChangeFailed"));
    } finally {
      setBusy(null);
    }
  };
  const setSharedRead = async (plugin: InstalledPlugin, read: PluginSharedReadStatus, approved: boolean): Promise<void> => {
    if (!onSetSharedReadApproved) return;
    setBusy(plugin.manifest.id);
    setError(null);
    try {
      await onSetSharedReadApproved(plugin.manifest.id, read.plugin, read.method, approved);
      setConfirming(null);
    } catch {
      setError(t(locale, "pluginHookChangeFailed"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="setting-group agent-hooks plugin-services">
      <h3>{t(locale, "pluginNativeCode")}</h3>
      <p className="setting-group__description">{t(locale, "pluginNativeCodeDescription")}</p>
      <div className="agent-hooks__list">
        {rows.map((plugin) => {
          const pluginId = plugin.manifest.id;
          const trusted = plugin.nativeCodeTrusted;
          const report = reports[pluginId];
          return (
            <article className="agent-hooks__row" key={pluginId}>
              <div className="agent-hooks__row-main">
                <span className="agent-hooks__copy">
                  <strong>{pluginName(plugin.manifest, locale)}</strong>
                  <small>{t(locale, "pluginNativeCodeServices")}</small>
                </span>
                <button
                  className={`agent-hooks__toggle${trusted ? " agent-hooks__toggle--on" : ""}`}
                  type="button"
                  role="switch"
                  aria-checked={trusted}
                  aria-label={`${t(locale, "pluginNativeCode")}: ${pluginName(plugin.manifest, locale)}`}
                  disabled={!plugin.enabled || busy !== null}
                  onClick={() => {
                    if (trusted) void setTrusted(plugin, false);
                    else setConfirming(pluginId);
                  }}
                >
                  <span aria-hidden="true" />
                  {t(locale, trusted ? "on" : "off")}
                </button>
              </div>
              <dl className="agent-hooks__meta">
                {(plugin.manifest.services ?? []).map((service) => {
                  const status = report?.services.find((candidate) => candidate.serviceId === service.id);
                  return (
                    <div key={service.id}>
                      <dt>{service.title}</dt>
                      <dd>
                        <code>{service.entry}</code>
                        {" · "}
                        {t(locale, stateKey(status?.state ?? "stopped"))}
                        {status?.lastError ? ` · ${status.lastError}` : ""}
                      </dd>
                    </div>
                  );
                })}
              </dl>
              {trusted && plugin.manifest.services?.some((service) => service.decide) && (
                <div className="agent-hooks__row-main">
                  <span className="agent-hooks__copy">
                    <strong>{t(locale, "pluginDecisionsMayAllow")}</strong>
                    <span>{t(locale, "pluginDecisionsMayAllowDescription")}</span>
                  </span>
                  <button
                    className={`agent-hooks__toggle${plugin.decisionsMayAllow ? " agent-hooks__toggle--on" : ""}`}
                    type="button"
                    role="switch"
                    aria-checked={plugin.decisionsMayAllow}
                    aria-label={`${t(locale, "pluginDecisionsMayAllow")}: ${pluginName(plugin.manifest, locale)}`}
                    disabled={busy !== null}
                    onClick={() => {
                      if (plugin.decisionsMayAllow) void setMayAllow(plugin, false);
                      else setConfirming(`${pluginId}:allow`);
                    }}
                  >
                    <span aria-hidden="true" />
                    {t(locale, plugin.decisionsMayAllow ? "on" : "off")}
                  </button>
                </div>
              )}
              {confirming === `${pluginId}:allow` && (
                <div className="agent-hooks__confirm">
                  <p>{t(locale, "pluginDecisionsMayAllowConfirm")}</p>
                  <div>
                    <button type="button" onClick={() => setConfirming(null)}>{t(locale, "cancel")}</button>
                    <button
                      className="agent-hooks__trust"
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void setMayAllow(plugin, true)}
                    >{t(locale, "pluginDecisionsMayAllowEnable")}</button>
                  </div>
                </div>
              )}
              {trusted && plugin.manifest.permissions?.includes("sessions:launch") && (
                <div className="agent-hooks__row-main">
                  <span className="agent-hooks__copy">
                    <strong>{orchestratorText.title}</strong>
                    <small>{orchestratorText.description}</small>
                  </span>
                  <button
                    className={`agent-hooks__toggle${plugin.mayStartOrchestrators ? " agent-hooks__toggle--on" : ""}`}
                    type="button"
                    role="switch"
                    aria-checked={plugin.mayStartOrchestrators}
                    aria-label={`${orchestratorText.title}: ${plugin.manifest.name}`}
                    disabled={busy !== null}
                    onClick={() => {
                      if (plugin.mayStartOrchestrators) void setMayStartOrchestrators(plugin, false);
                      else setConfirming(`${pluginId}:orchestrators`);
                    }}
                  >
                    <span aria-hidden="true" />
                    {t(locale, plugin.mayStartOrchestrators ? "on" : "off")}
                  </button>
                </div>
              )}
              {confirming === `${pluginId}:orchestrators` && (
                <div className="agent-hooks__confirm">
                  <p>{orchestratorText.confirm}</p>
                  <div>
                    <button type="button" onClick={() => setConfirming(null)}>{t(locale, "cancel")}</button>
                    <button
                      className="agent-hooks__trust"
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void setMayStartOrchestrators(plugin, true)}
                    >{orchestratorText.enable}</button>
                  </div>
                </div>
              )}
              {trusted && plugin.trustKeptOnUpdate && (
                <div className="agent-hooks__confirm" role="status">
                  <p>{updateTrustText.kept.replace("{from}", plugin.trustKeptOnUpdate.fromVersion).replace("{to}", plugin.trustKeptOnUpdate.toVersion)}</p>
                  <div>
                    <button type="button" disabled={busy !== null} onClick={() => void setTrusted(plugin, false)}>{updateTrustText.revoke}</button>
                  </div>
                </div>
              )}
              {trusted && onSetTrustUpdates && plugin.sourceUrl.startsWith("https://github.com/") && (
                <div className="agent-hooks__row-main">
                  <span className="agent-hooks__copy">
                    <strong>{updateTrustText.title} <code>{repositoryLabel(plugin.sourceUrl)}</code></strong>
                    <small>{updateTrustText.description} {updateTrustText.risk}</small>
                  </span>
                  <button
                    className={`agent-hooks__toggle${plugin.trustUpdates ? " agent-hooks__toggle--on" : ""}`}
                    type="button"
                    role="switch"
                    aria-checked={plugin.trustUpdates === true}
                    aria-label={`${updateTrustText.title} ${repositoryLabel(plugin.sourceUrl)}: ${pluginName(plugin.manifest, locale)}`}
                    disabled={busy !== null}
                    onClick={() => {
                      if (plugin.trustUpdates) void setTrustUpdates(plugin, false);
                      else setConfirming(`${pluginId}:updates`);
                    }}
                  >
                    <span aria-hidden="true" />
                    {t(locale, plugin.trustUpdates ? "on" : "off")}
                  </button>
                </div>
              )}
              {confirming === `${pluginId}:updates` && (
                <div className="agent-hooks__confirm">
                  <p>{updateTrustText.risk}</p>
                  <div>
                    <button type="button" onClick={() => setConfirming(null)}>{t(locale, "cancel")}</button>
                    <button
                      className="agent-hooks__trust"
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void setTrustUpdates(plugin, true)}
                    >{updateTrustText.enable}</button>
                  </div>
                </div>
              )}
              {trusted && onSetSharedReadApproved && (plugin.sharedReads ?? []).length > 0 && (
                <div className="plugin-shared-reads">
                  <span className="agent-hooks__copy">
                    <strong>{sharedReadText(locale, "title")}</strong>
                    <small>{sharedReadText(locale, "description")}</small>
                  </span>
                  {(plugin.sharedReads ?? []).map((read) => {
                    const key = `${pluginId}:read:${read.plugin} ${read.method}`;
                    const approved = read.state === "approved";
                    const note = read.state === "not-shared" ? sharedReadText(locale, "notShared")
                      : read.state === "changed" ? sharedReadText(locale, "changed")
                        : !read.providerReady ? sharedReadText(locale, "providerOff") : null;
                    return (
                      <div key={key}>
                        <div className="agent-hooks__row-main">
                          <span className="agent-hooks__copy">
                            <strong>{read.providerName ?? read.plugin} · <code>{read.method}</code></strong>
                            <small>{[
                              read.description,
                              read.dataClass ? `${sharedReadText(locale, "dataClass")} ${read.dataClass}` : null,
                              note
                            ].filter(Boolean).join(" · ")}</small>
                          </span>
                          <button
                            className={`agent-hooks__toggle${approved ? " agent-hooks__toggle--on" : ""}`}
                            type="button"
                            role="switch"
                            aria-checked={approved}
                            aria-label={`${sharedReadText(locale, "title")}: ${read.providerName ?? read.plugin} ${read.method}`}
                            disabled={busy !== null || (!approved && read.state === "not-shared")}
                            onClick={() => {
                              if (approved) void setSharedRead(plugin, read, false);
                              else if (read.state !== "not-shared") setConfirming(key);
                            }}
                          >
                            <span aria-hidden="true" />
                            {t(locale, approved ? "on" : "off")}
                          </button>
                        </div>
                        {confirming === key && (
                          <div className="agent-hooks__confirm">
                            <p>{sharedReadText(locale, "confirm")}</p>
                            <div>
                              <button type="button" onClick={() => setConfirming(null)}>{t(locale, "cancel")}</button>
                              <button
                                className="agent-hooks__trust"
                                type="button"
                                disabled={busy !== null}
                                onClick={() => void setSharedRead(plugin, read, true)}
                              >{sharedReadText(locale, "allow")}</button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
              {trusted && plugin.manifest.services?.some((service) => service.brokerable) && (
                <PluginBrokerGrants
                  locale={locale}
                  ownerId={pluginId}
                  refreshKey={brokerKey}
                  busy={busy !== null}
                  onError={setError}
                />
              )}
              {!plugin.enabled && <p className="agent-hooks__disabled">{t(locale, "pluginHookDisabledPlugin")}</p>}
              {confirming === pluginId && (
                <div className="agent-hooks__confirm">
                  <p>{t(locale, "pluginNativeCodeConfirm")}</p>
                  <div>
                    <button
                      type="button"
                      onClick={() => void window.canvasTTY.githubAuth.openUrl(plugin.sourceUrl)}
                    >{t(locale, "pluginHookReviewRepository")}</button>
                    <button type="button" onClick={() => setConfirming(null)}>{t(locale, "cancel")}</button>
                    <button
                      className="agent-hooks__trust"
                      type="button"
                      disabled={!plugin.enabled || busy !== null}
                      onClick={() => void setTrusted(plugin, true)}
                    >{t(locale, "pluginHookTrustAndEnable")}</button>
                  </div>
                </div>
              )}
              {report && report.log.length > 0 && (
                <details className="plugin-services__log">
                  <summary>{t(locale, "pluginNativeCodeLog")}</summary>
                  <pre>{report.log.slice(-60).map((entry) => (
                    `${new Date(entry.at).toLocaleTimeString()} ${entry.serviceId} ${entry.source}: ${entry.message}`
                  )).join("\n")}</pre>
                </details>
              )}
            </article>
          );
        })}
      </div>
      {error && <p className="agent-hooks__error" role="alert">{error}</p>}
    </section>
  );
}

function stateKey(state: PluginServiceState): TranslationKey {
  return ({
    stopped: "pluginServiceStopped",
    starting: "pluginServiceStarting",
    running: "pluginServiceRunning",
    backoff: "pluginServiceRestarting",
    failed: "pluginServiceFailed"
  } as const)[state];
}
