import type { LocaleId } from "../../../../shared/contracts";

// Settings → About and its problem report form. Only Settings shows this text, so it lives here, in the lazily
// loaded Settings chunk, rather than in the startup string table.
const ABOUT_TEXT = {
  ru: {
    aboutDescription: "Пространственный рабочий стол для локальных терминалов и агентов.",
    aboutFaq: "Частые вопросы",
    aboutFaqDataAnswer: "Только состояние, ограниченное имя события и, при наличии, непрозрачный идентификатор хода. Текст промпта, ответ агента и входные данные инструментов не сохраняются в индикаторе статуса.",
    aboutFaqDataQuestion: "Какие данные передают статусные хуки?",
    aboutFaqDisableAnswer: "Текущие статусы сразу станут недоступны. Повторное включение применяется к новым или перезапущенным сессиям; уже работающий процесс не получает разрешение задним числом.",
    aboutFaqDisableQuestion: "Что произойдёт после отключения хуков?",
    aboutFaqPluginHooksAnswer: "Они запускают локальный код с правами вашей учётной записи и могут читать файлы или выполнять команды. После установки и обновления они выключены; перед включением проверьте репозиторий, исходный файл, провайдеров и список событий.",
    aboutFaqPluginHooksQuestion: "Чем опасны хуки плагинов?",
    aboutFaqProviderTrustAnswer: "Это собственная защита провайдера. CanvasTTY не обходит её: агент может запросить отдельное подтверждение даже при включённом отображении статуса.",
    aboutFaqProviderTrustQuestion: "Почему Codex или другой агент отдельно просит проверить bridge?",
    aboutFaqStatusAnswer: "Через структурированные события провайдера. CanvasTTY не угадывает состояние по тексту терминала и показывает только подтверждённые состояния: ожидание, работа или запрос ввода.",
    aboutFaqStatusQuestion: "Как CanvasTTY определяет статус агента?",
    diagnosticsAttachImage: "Прикрепить изображение",
    diagnosticsDescription: "Отчёт отправится разработчикам CanvasTTY. К описанию приложатся версия приложения, сведения о системе и журнал событий. Текст терминалов и переписка автоматически не собираются; известные секреты в журнале маскируются. Отправка происходит только по этой кнопке.",
    diagnosticsFailed: "Не удалось отправить отчёт. Описание и вложение остались в форме — попробуйте снова.",
    diagnosticsImageFailed: "Не удалось прикрепить изображение. Выберите корректный PNG или JPEG размером до 2 МиБ.",
    diagnosticsImageHelp: "Одно изображение PNG или JPEG до 2 МиБ. Выбранная картинка отправляется как есть, без скрытия содержимого.",
    diagnosticsImageLoading: "Читаем изображение…",
    diagnosticsImagePreview: "Прикреплённое изображение",
    diagnosticsPlaceholder: "Например: открыл OpenCode, нажал Enter и увидел ошибку…",
    diagnosticsProblem: "Что произошло и как это повторить?",
    diagnosticsRemoveImage: "Убрать изображение",
    diagnosticsReplaceImage: "Заменить изображение",
    diagnosticsSend: "Отправить описание и диагностику",
    diagnosticsSending: "Отправляем…",
    diagnosticsSent: "Отчёт принят. Его номер",
    diagnosticsTitle: "Сообщить об ошибке",
    diagnosticsTooLarge: "Журнал вместе с изображением превышает лимит отчёта. Выберите картинку меньшего размера или уберите её; описание сохранено.",
    diagnosticsUnavailable: "Сервер отчётов пока не подключён. Журнал событий сохраняется на этом компьютере."
  },
  en: {
    aboutDescription: "A spatial desktop for local terminals and agents.",
    aboutFaq: "Frequently asked questions",
    aboutFaqDataAnswer: "Only state, a bounded event name, and an optional opaque turn identifier. Prompt text, agent responses, and tool input are not retained by the status display.",
    aboutFaqDataQuestion: "What do status hooks send?",
    aboutFaqDisableAnswer: "Current statuses immediately become unavailable. Re-enabling applies to new or restarted sessions; an already running process does not gain permission retroactively.",
    aboutFaqDisableQuestion: "What happens when hooks are disabled?",
    aboutFaqPluginHooksAnswer: "They run local code with your account privileges and can read files or execute commands. They are off after install and update; review the repository, entry file, providers, and events before enabling one.",
    aboutFaqPluginHooksQuestion: "Why are plugin hooks sensitive?",
    aboutFaqProviderTrustAnswer: "That is the provider's own safety gate. CanvasTTY does not bypass it, so an agent may request separate approval even while status reporting is enabled.",
    aboutFaqProviderTrustQuestion: "Why can Codex or another agent ask to review the bridge?",
    aboutFaqStatusAnswer: "It uses structured provider events. CanvasTTY does not guess from terminal text and displays only confirmed waiting, working, or input-required states.",
    aboutFaqStatusQuestion: "How does CanvasTTY determine agent status?",
    diagnosticsAttachImage: "Attach image",
    diagnosticsDescription: "Your report will be sent to the CanvasTTY developers. Your description will include the app version, system information and event log. Terminal text and conversations are not collected automatically; known secrets in logs are masked. Reports are sent only using this button.",
    diagnosticsFailed: "Could not send the report. Your description and attachment are still in the form — please try again.",
    diagnosticsImageFailed: "Could not attach the image. Choose a valid PNG or JPEG file up to 2 MiB.",
    diagnosticsImageHelp: "One PNG or JPEG image up to 2 MiB. The selected image is sent as is, without hiding its contents.",
    diagnosticsImageLoading: "Reading image…",
    diagnosticsImagePreview: "Attached image",
    diagnosticsPlaceholder: "For example: I opened OpenCode, pressed Enter and saw an error…",
    diagnosticsProblem: "What happened and how can we reproduce it?",
    diagnosticsRemoveImage: "Remove image",
    diagnosticsReplaceImage: "Replace image",
    diagnosticsSend: "Send description and diagnostics",
    diagnosticsSending: "Sending…",
    diagnosticsSent: "Report received. Reference",
    diagnosticsTitle: "Report a problem",
    diagnosticsTooLarge: "The log and image exceed the report size limit. Choose a smaller image or remove it; your description is still in the form.",
    diagnosticsUnavailable: "The report server is not connected yet. The event log stays on this computer."
  }
} satisfies Record<LocaleId, Record<string, string>>;

export type AboutTextKey = keyof typeof ABOUT_TEXT.en;

export function aboutText(locale: LocaleId, key: AboutTextKey): string {
  return ABOUT_TEXT[locale === "ru" ? "ru" : "en"][key];
}
