import type { LocaleId } from "../../../../shared/contracts";

/**
 * Text for brokered model requests (an extension sending requests through another extension's account). It is shown
 * only inside Settings, so it lives in the Settings chunk instead of the eager translation table.
 */
const ru = {
  title: "Учётные записи для других расширений",
  description: "Расширения ниже могут отправлять запросы к модели через эти учётные записи. Ключ остаётся у этого расширения: CanvasTTY сам подставляет его и отправляет запрос только на указанный адрес. Каждую пару разрешаете вы; квоту и лимиты решает это расширение. Запросы видны в журнале обоих расширений (размеры и хеши, без текста).",
  none: "Это расширение сейчас не предлагает учётных записей. Отметьте нужные на его странице.",
  unavailable: "Сервис расширения не запущен: список недоступен.",
  noCallers: "Ни одно установленное расширение не просит доступа к учётным записям.",
  callerOff: "его нативный код выключен",
  changed: "адрес, протокол или способ входа изменились: разрешите снова",
  flatRate: "подписка",
  confirm: "Расширение сможет отправлять запросы к модели через эту учётную запись, пока работают его сервисы. Ключ оно не увидит, но запросы расходуют квоту или деньги этой учётной записи. Проверьте, что условия тарифа это допускают.",
  allow: "Разрешить",
  origin: "Адрес",
  models: "Модели",
  allTitle: "Все учётные записи этого расширения",
  allDescription: "Одно разрешение на все учётные записи, которые это расширение предлагает другим (те, что вы отметили на его странице), включая добавленные позже на уже разрешённых адресах.",
  allConfirm: "Расширение сможет отправлять запросы через каждую учётную запись, которую это расширение предлагает сейчас или предложит позже на этих адресах. Учётная запись на новом адресе будет ждать вашего разрешения. Запросы расходуют квоту или деньги этих учётных записей.",
  allAddresses: "Адреса сейчас:",
  allNone: "сейчас нет ни одной учётной записи; первая на новом адресе будет ждать разрешения",
  covered: "входит в разрешение на все учётные записи",
  newAddress: "новый адрес: разрешите все учётные записи снова, чтобы включить его",
  allowNewAddress: "Разрешить новые адреса",
  allChanged: "источник расширения изменился: разрешите снова"
};

const en: Record<keyof typeof ru, string> = {
  title: "Accounts for other extensions",
  description: "The extensions below may send model requests through these accounts. The key stays with this extension: CanvasTTY adds it itself and sends the request only to the address shown. You allow each pair; this extension decides quota and limits. Requests show in both extensions' logs (sizes and hashes, no text).",
  none: "This extension offers no accounts now. Mark the ones you want on its page.",
  unavailable: "The extension's service is not running, so the list is not available.",
  noCallers: "No installed extension asks to use accounts.",
  callerOff: "its native code is off",
  changed: "address, protocol or sign-in changed: allow it again",
  flatRate: "subscription",
  confirm: "The extension can send model requests through this account whenever its services run. It never sees the key, but the requests use this account's quota or money. Check that the plan's terms allow it.",
  allow: "Allow",
  origin: "Address",
  models: "Models",
  allTitle: "Every account of this extension",
  allDescription: "One grant for every account this extension offers to others (the ones you marked on its page), including accounts added later on addresses already allowed.",
  allConfirm: "The extension can send requests through every account this extension offers now, or offers later on these addresses. An account on a new address waits for your permission. Requests use these accounts' quota or money.",
  allAddresses: "Addresses now:",
  allNone: "no account is offered now; the first one on a new address will wait for your permission",
  covered: "covered by the grant for every account",
  newAddress: "new address: allow every account again to include it",
  allowNewAddress: "Allow the new addresses",
  allChanged: "the extension's source changed: allow it again"
};

export function brokerText(locale: LocaleId, key: keyof typeof ru): string {
  return (locale === "ru" ? ru : en)[key];
}
