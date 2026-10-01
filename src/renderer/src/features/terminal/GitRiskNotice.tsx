import { useState } from "react";
import type { GitRiskItem, GitRiskReport, LocaleId } from "../../../../shared/contracts";
import { t } from "../../lib/i18n";

/** One line per finding: the exact config key and value, the hook, or info/attributes. */
export function gitRiskItemText(item: GitRiskItem): string {
  if (item.kind === "config") return `${item.key} = ${item.value}`;
  if (item.kind === "hook") return `hooks/${item.name}`;
  return "info/attributes";
}

/**
 * What an isolated agent left in repositories under its folder that git would run outside the layer. Nothing is
 * changed until the person chooses: Neutralize removes exactly the listed keys and disables the listed files; Keep
 * leaves them.
 */
export function GitRiskNotice({ report, locale, closedTitle, className = "", onResolved }: {
  report: GitRiskReport;
  locale: LocaleId;
  /** Called once the choice was carried out (a card's own report clears through its session instead). */
  onResolved?: () => void;
  /** For a card that was closed: its title. */
  closedTitle?: string;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const resolve = (action: "neutralize" | "keep"): void => {
    setBusy(true);
    setFailure(null);
    window.canvasTTY.terminal.resolveGitRisk(report.id, action).then(() => onResolved?.(), (error: unknown) => {
      setFailure(`${t(locale, "gitRiskFailed")} ${error instanceof Error ? error.message : String(error)}`);
      setBusy(false);
    });
  };
  return (
    <div className={`git-risk ${className}`} role="alert">
      <strong>{t(locale, "gitRiskTitle")}</strong>
      <span>{closedTitle !== undefined ? `${t(locale, "gitRiskClosed")} «${closedTitle}». ` : ""}{t(locale, "gitRiskDetail")}</span>
      <ul className="git-risk__list">
        {report.repositories.map((repository) => (
          <li key={repository.path}>
            <code>{repository.path}</code>
            <ul>{repository.items.map((item) => <li key={gitRiskItemText(item)}><code>{gitRiskItemText(item)}</code></li>)}</ul>
          </li>
        ))}
      </ul>
      {failure && <span className="git-risk__failure">{failure}</span>}
      <div className="git-risk__actions">
        <button type="button" disabled={busy} onClick={() => resolve("neutralize")}>{t(locale, "gitRiskNeutralize")}</button>
        <button type="button" disabled={busy} onClick={() => resolve("keep")}>{t(locale, "gitRiskKeep")}</button>
      </div>
    </div>
  );
}
