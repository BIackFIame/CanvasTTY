import type { LocaleId } from "../../../../shared/contracts";

/**
 * Text for shared reads between plugins. It is shown only inside Settings, so it lives in the Settings chunk instead
 * of the eager translation table.
 */
const ru = {
  usesTitle: "Читает данные других расширений",
  usesNote: "Каждое такое чтение работает только после вашего разрешения в разделе «Нативный код расширений».",
  sharesTitle: "Делится данными с другими расширениями (только чтение, по вашему разрешению)",
  description: "Сервисы этого расширения могут запрашивать у другого расширения данные ниже. Каждую пару разрешаете вы. Что отдать, решает другое расширение; CanvasTTY не пропускает ответ больше 256 КБ или с известным ему секретом и пишет в журнал только хеши. Обновление или выключение нативного кода снимают разрешения.",
  confirm: "Это расширение сможет читать эти данные, пока работают его сервисы. Разрешайте, только если доверяете ему эти данные.",
  allow: "Разрешить чтение",
  notShared: "не установлено или не делится этими данными",
  changed: "изменилось после вашего разрешения: разрешите снова",
  providerOff: "его нативный код выключен",
  dataClass: "Класс данных",
  title: "Чтение данных других расширений",
};

const en: Record<keyof typeof ru, string> = {
  usesTitle: "Reads data from other extensions",
  usesNote: "Each of these reads works only after you allow it under Extension native code.",
  sharesTitle: "Shares data with other extensions (read-only, when you allow it)",
  description: "This extension's services may ask another extension for the data below. You allow each pair. The other extension decides what it returns; CanvasTTY refuses an answer over 256 KB or holding a secret it knows, and logs only hashes. An update or turning native code off removes the approvals.",
  confirm: "This extension can read this data whenever its services run. Allow it only if you trust it with this data.",
  allow: "Allow reading",
  notShared: "not installed, or does not share this data",
  changed: "changed since you allowed it: allow it again",
  providerOff: "its native code is off",
  dataClass: "Data class",
  title: "Reads from other extensions",
};

export function sharedReadText(locale: LocaleId, key: keyof typeof ru): string {
  return (locale === "ru" ? ru : en)[key];
}
