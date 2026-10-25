import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { InstalledPlugin, LocaleId } from "../../../../shared/contracts";
import { pluginName } from "../../../../shared/pluginLocalizedText.ts";
import {
  GrantGate,
  applyGrants,
  declinedResults,
  parseGrantRequest,
  planGrants,
  rowApplies,
  type GrantPlan,
  type GrantResult,
  type GrantRow
} from "./grantsPlan";

/** The dialog's text: shown only here, so it lives in this lazily loaded chunk. */
const TEXT = {
  ru: {
    title: "Разрешения для «{plugin}»",
    intro: "Расширение просит разрешений ниже. CanvasTTY применит только отмеченные; каждое можно отозвать в Настройках → Агенты → Нативный код расширений.",
    says: "Расширение пишет:",
    allow: "Разрешить выбранное",
    cancel: "Отмена",
    nativeCode: "Нативный код: {name}",
    nativeCodeDetail: "Его сервисы работают как программы с вашими правами в системе. Источник: {source}. Права: {permissions}.",
    mayStart: "Может запускать оркестраторов",
    mayStartDetail: "Окна оркестраторов сами запускают субагентов на выбранных расширением CLI, папке и среде; YOLO недоступен, защита и изоляция действуют.",
    decisions: "Может разрешать действия агентов",
    decisionsDetail: "Ответ «разрешить» от его сервиса решений выполняет вызов инструмента без вопроса агента.",
    sharedRead: "Читает у {provider}: {method}",
    sharedReadDetail: "{description} Класс данных: {dataClass}.",
    broker: "Запросы к моделям через {owner}: {account}",
    brokerAll: "все учётные записи, которые оно предлагает (отмеченные на его странице), и новые на тех же адресах",
    brokerDetail: "Ключ остаётся у {owner}; запросы расходуют квоту или деньги этих учётных записей. Сейчас: {accounts}.",
    brokerNone: "список появится, когда сервис {owner} запустится",
    trustUpdates: "Доверять обновлениям из {source}",
    trustUpdatesDetail: "Пока обновления не просят новых прав, ничего не нужно включать заново. Если кто-то получит доступ к этому репозиторию, его код запустится у вас при следующем обновлении.",
    needs: "нужен нативный код: {names}",
    failed: "Не удалось: {reason}"
  },
  en: {
    title: "Permissions for “{plugin}”",
    intro: "The extension asks for the permissions below. CanvasTTY applies only the ticked ones; you can revoke each in Settings → Agents → Extension native code.",
    says: "The extension says:",
    allow: "Allow selected",
    cancel: "Cancel",
    nativeCode: "Native code: {name}",
    nativeCodeDetail: "Its services run as programs with your OS privileges. Source: {source}. Permissions: {permissions}.",
    mayStart: "May start orchestrators",
    mayStartDetail: "Orchestrator cards start subagents of their own on the CLI, folder and environment the extension chooses; never YOLO, protection and isolation apply.",
    decisions: "May allow agent actions",
    decisionsDetail: "An “allow” from its decision service runs the tool call without the agent's own prompt.",
    sharedRead: "Reads from {provider}: {method}",
    sharedReadDetail: "{description} Data class: {dataClass}.",
    broker: "Model requests through {owner}: {account}",
    brokerAll: "every account it offers (the ones marked on its page), and new ones on the same addresses",
    brokerDetail: "The key stays with {owner}; requests use these accounts' quota or money. Now: {accounts}.",
    brokerNone: "the list appears once the {owner} service runs",
    trustUpdates: "Trust updates from {source}",
    trustUpdatesDetail: "While updates ask for no new permissions, nothing has to be turned on again. If someone gets access to this repository, their code runs on your computer at the next update.",
    needs: "needs native code: {names}",
    failed: "Failed: {reason}"
  }
} as const;
type Text = { -readonly [K in keyof typeof TEXT.en]: string };

const fill = (template: string, values: Record<string, string>): string => template.replace(/\{(\w+)\}/gu, (_, key: string) => values[key] ?? "");
const repository = (sourceUrl: string): string => /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/iu.exec(sourceUrl)?.[1] ?? sourceUrl;

function rowText(row: GrantRow, text: Text, locale: LocaleId): { title: string; detail: string } {
  const item = row.item;
  const name = (plugin: InstalledPlugin | undefined, fallback: string): string => plugin ? pluginName(plugin.manifest, locale) : fallback;
  switch (item.kind) {
    case "nativeCode":
      return {
        title: fill(text.nativeCode, { name: name(row.subject, item.plugin) }),
        detail: fill(text.nativeCodeDetail, { source: repository(row.subject.sourceUrl), permissions: row.subject.manifest.permissions.join(", ") || "—" })
      };
    case "mayStartOrchestrators": return { title: text.mayStart, detail: text.mayStartDetail };
    case "decisionsMayAllow": return { title: text.decisions, detail: text.decisionsDetail };
    case "sharedRead": {
      const status = row.subject.sharedReads?.find((read) => read.plugin === item.provider && read.method === item.method);
      return {
        title: fill(text.sharedRead, { provider: name(row.other, item.provider), method: item.method }),
        detail: fill(text.sharedReadDetail, { description: status?.description ?? "", dataClass: status?.dataClass ?? "—" })
      };
    }
    case "brokerGrant": {
      const owner = name(row.other, item.owner);
      const accounts = row.accounts?.length
        ? row.accounts.map((account) => `${account.label} (${account.origin}; ${account.models.slice(0, 4).join(", ")})`).join("; ")
        : fill(text.brokerNone, { owner });
      return {
        title: fill(text.broker, { owner, account: item.account === "*" ? text.brokerAll : row.accounts?.[0]?.label ?? item.account }),
        detail: fill(text.brokerDetail, { owner, accounts })
      };
    }
    case "trustUpdates":
      return { title: fill(text.trustUpdates, { source: repository(row.subject.sourceUrl) }), detail: text.trustUpdatesDetail };
  }
}

export function GrantsDialog({ plan, plugins, locale, onDone }: {
  plan: GrantPlan;
  plugins: readonly InstalledPlugin[];
  locale: LocaleId;
  onDone(ticks: boolean[] | null): void;
}): React.JSX.Element {
  const text: Text = TEXT[locale === "ru" ? "ru" : "en"];
  const [ticks, setTicks] = useState(() => plan.rows.map((row) => row.ticked));
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    // Focus starts on Cancel, so a stray Enter never allows anything.
    cancel.current?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") { event.preventDefault(); onDone(null); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onDone]);
  const title = fill(text.title, { plugin: pluginName(plan.requester.manifest, locale) });
  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="grants-dialog" role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        <p className="grants-dialog__intro">{text.intro}</p>
        {plan.reason && <blockquote className="grants-dialog__reason"><small>{text.says}</small> “{plan.reason}”</blockquote>}
        <ul className="grants-dialog__list">
          {plan.rows.map((row, position) => {
            const { title: rowTitle, detail } = rowText(row, text, locale);
            const applies = rowApplies(plan, ticks, row, plugins);
            const blocked = ticks[position] && !applies;
            const missing = row.needs.filter((id) => !plugins.find((plugin) => plugin.manifest.id === id)?.nativeCodeTrusted
              && !plan.rows.some((other, index) => other.item.kind === "nativeCode" && other.item.plugin === id && ticks[index]));
            return (
              <li key={row.index} className={blocked ? "grants-dialog__item grants-dialog__item--blocked" : "grants-dialog__item"}>
                <label>
                  <input
                    type="checkbox"
                    checked={ticks[position]}
                    onChange={(event) => setTicks((current) => current.map((value, index) => index === position ? event.target.checked : value))}
                  />
                  <span>
                    <strong>{rowTitle}</strong>
                    <small>{detail}</small>
                    {blocked && <small className="grants-dialog__needs">{fill(text.needs, {
                      names: missing.map((id) => { const plugin = plugins.find((candidate) => candidate.manifest.id === id); return plugin ? pluginName(plugin.manifest, locale) : id; }).join(", ")
                    })}</small>}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
        <div className="grants-dialog__actions">
          <button ref={cancel} type="button" onClick={() => onDone(null)}>{text.cancel}</button>
          <button
            className="grants-dialog__allow"
            type="button"
            disabled={!plan.rows.some((row) => rowApplies(plan, ticks, row, plugins))}
            onClick={() => onDone(ticks)}
          >{text.allow}</button>
        </div>
      </section>
    </div>
  );
}

const gate = new GrantGate();

/** Shows the dialog in its own root above the app and resolves with the ticks, or null when the person declined. */
function showDialog(plan: GrantPlan, plugins: readonly InstalledPlugin[], locale: LocaleId): Promise<boolean[] | null> {
  return new Promise((resolve) => {
    const host = document.createElement("div");
    host.className = "grants-dialog-host";
    document.body.appendChild(host);
    const root = createRoot(host);
    // The app hides the native Browser and holds its canvas shortcuts while the dialog is open.
    const opened = (open: boolean): boolean => window.dispatchEvent(new CustomEvent("canvastty:grants-dialog", { detail: open }));
    opened(true);
    const done = (ticks: boolean[] | null): void => {
      root.unmount();
      host.remove();
      opened(false);
      resolve(ticks);
    };
    root.render(<GrantsDialog plan={plan} plugins={plugins} locale={locale} onDone={done} />);
  });
}

/**
 * `grants.request` from a plugin frame (see grantsPlan for the rules). `personInFrame`: the person is in the asking
 * frame now. Answers `{ results }`, one per requested item in order.
 */
export async function requestGrants(input: {
  plugin: InstalledPlugin;
  params: unknown;
  personInFrame: boolean;
  locale: LocaleId;
}): Promise<{ results: GrantResult[] }> {
  if (!input.personInFrame) throw new Error("grants.request answers only an action of the person in this plugin surface.");
  const request = parseGrantRequest(input.params);
  const pluginId = input.plugin.manifest.id;
  gate.enter(pluginId);
  let allDeclined = false;
  try {
    const api = window.canvasTTY.plugins;
    const plugins = await api.list();
    const plan = await planGrants(pluginId, request, plugins, (owner) => api.brokerAccounts(owner));
    if (plan.rows.length === 0) return { results: declinedResults(plan) };
    const ticks = await showDialog(plan, plugins, input.locale);
    if (!ticks || !plan.rows.some((row) => rowApplies(plan, ticks, row, plugins))) {
      allDeclined = true;
      return { results: declinedResults(plan) };
    }
    const results = await applyGrants(plan, ticks, plugins, {
      setNativeCodeTrusted: api.setNativeCodeTrusted,
      setMayStartOrchestrators: api.setMayStartOrchestrators,
      setDecisionsMayAllow: api.setDecisionsMayAllow,
      setSharedReadApproved: api.setSharedReadApproved,
      setBrokerGrant: api.setBrokerGrant,
      setTrustUpdates: api.setTrustUpdates,
      brokerAccounts: api.brokerAccounts,
      wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    });
    // The app's plugin list (Settings, launcher) reads the new state.
    window.dispatchEvent(new Event("canvastty:plugins-changed"));
    return { results };
  } finally {
    gate.leave(pluginId, allDeclined);
  }
}
