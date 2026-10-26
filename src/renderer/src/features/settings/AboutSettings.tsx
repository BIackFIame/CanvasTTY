import appManifest from "../../../../../package.json";
import type { LocaleId } from "../../../../shared/contracts";
import { aboutText, type AboutTextKey } from "./aboutText";
import { DiagnosticSettings } from "./DiagnosticSettings";

const FAQ: ReadonlyArray<readonly [AboutTextKey, AboutTextKey]> = [
  ["aboutFaqStatusQuestion", "aboutFaqStatusAnswer"],
  ["aboutFaqDataQuestion", "aboutFaqDataAnswer"],
  ["aboutFaqDisableQuestion", "aboutFaqDisableAnswer"],
  ["aboutFaqProviderTrustQuestion", "aboutFaqProviderTrustAnswer"],
  ["aboutFaqPluginHooksQuestion", "aboutFaqPluginHooksAnswer"]
];

export function AboutSettings({ locale }: { locale: LocaleId }): React.JSX.Element {
  return (
    <section className="about-settings">
      <header className="about-settings__header">
        <span>
          <strong>CanvasTTY</strong>
          <small>v{appManifest.version}</small>
        </span>
        <p>{aboutText(locale, "aboutDescription")}</p>
      </header>

      <DiagnosticSettings locale={locale} />

      <div className="about-settings__faq">
        <h3>{aboutText(locale, "aboutFaq")}</h3>
        {FAQ.map(([question, answer]) => (
          <details key={question}>
            <summary>{aboutText(locale, question)}</summary>
            <p>{aboutText(locale, answer)}</p>
          </details>
        ))}
      </div>
    </section>
  );
}
