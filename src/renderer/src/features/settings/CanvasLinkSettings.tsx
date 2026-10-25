import { useEffect, useRef, useState } from "react";
import type { LocaleId } from "../../../../shared/contracts";
import type { CanvasLinkCommand, CanvasLinkState } from "../../../../shared/canvasLink";
import { CANVASLINK_ANDROID_RELEASE, canvasLinkInstallPrompt } from "../../../../shared/canvasLinkInstall";
import "./CanvasLinkSettings.css";

export function CanvasLinkSettings({ locale, open }: { locale: LocaleId; open: boolean }) {
  const [state, setState] = useState<CanvasLinkState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [promptCopied, setPromptCopied] = useState(false);
  const revision = useRef(0);
  const text = (ru: string, en: string) => locale === "ru" ? ru : en;

  function copyInstallPrompt() {
    try {
      window.canvasTTY.clipboard.writeText(canvasLinkInstallPrompt(locale));
      setPromptCopied(true);
    } catch {
      setPromptCopied(false);
      setError(text("Не удалось скопировать промпт. Откройте инструкцию.", "Could not copy the prompt. Open the installation guide."));
    }
  }

  useEffect(() => {
    if (!open) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const current = revision.current;
      try {
        const next = await window.canvasTTY.canvasLink.state();
        if (active && current === revision.current) setState(next);
      } catch {
        if (active) setError(locale === "ru" ? "Не удалось получить состояние подключения." : "Could not read connection status.");
      } finally {
        if (active) timer = setTimeout(poll, 1000);
      }
    }
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [open, locale]);

  async function run(action: CanvasLinkCommand) {
    revision.current++;
    setBusy(true);
    setError("");
    try { setState(await window.canvasTTY.canvasLink.command(action)); }
    catch { setError(text("Действие не выполнено. Попробуйте ещё раз.", "The action failed. Try again.")); }
    finally { revision.current++; setBusy(false); }
  }
  const button = (label: string, action: CanvasLinkCommand, primary = false) => (
    <button type="button" className={`canvaslink-settings__button${primary ? " canvaslink-settings__button--primary" : ""}`}
      disabled={busy} onClick={() => void run(action)} data-canvaslink-action={action}>{label}</button>
  );
  const enabled = !!state?.enabled;
  const devices = state?.devices ?? [];
  const seconds = Math.max(0, Math.ceil(((state?.expires ?? 0) - Date.now()) / 1000));
  const status = !enabled ? text("Выключено", "Off") : devices.length
    ? state?.phase === "streaming" ? text("Подключено · видео и управление", "Connected · video and control")
      : text("Устройство связано · подключение", "Device paired · connecting")
    : text("Ожидает подключения", "Waiting for connection");

  return <div className="canvaslink-settings" data-canvaslink-settings>
    <section className="canvaslink-settings__intro">
      <p className="canvaslink-settings__eyebrow">{text("ТЕЛЕФОН И ПЛАНШЕТ", "PHONE AND TABLET")}</p>
      <h3>{text("Ваш CanvasTTY на Android", "Your CanvasTTY on Android")}</h3>
      <p>{text("Работайте в этом окне с планшета или телефона. Оба устройства должны быть в одной локальной сети.", "Use this window from your tablet or phone. Both devices must be on the same local network.")}</p>
    </section>
    <section className="canvaslink-settings__card">
      <h3>{text("Установить на Android", "Install on Android")}</h3>
      <p>{text("Подключите телефон или планшет по USB, включите USB-отладку и подтвердите запрос на Android. Скопируйте промпт своему агенту — он проверит APK и установит приложение. После установки USB не нужен.", "Connect your phone or tablet over USB, enable USB debugging and approve the Android prompt. Copy the prompt to your agent: it will verify the APK and install the app. USB is not needed after installation.")}</p>
      <div className="canvaslink-settings__install-actions">
        <button type="button" className="canvaslink-settings__button" onClick={copyInstallPrompt}>{text("Скопировать промпт агенту", "Copy prompt for agent")}</button>
        <button type="button" className="canvaslink-settings__button" onClick={() => void window.canvasTTY.external.openUrl(locale === "ru" ? CANVASLINK_ANDROID_RELEASE.guideRuUrl : CANVASLINK_ANDROID_RELEASE.guideUrl)}>{text("Инструкция и APK", "Guide and APK")}</button>
      </div>
      {promptCopied && <p className="canvaslink-settings__note" role="status">{text("Промпт скопирован. Вставьте его в чат с агентом на этом компьютере.", "Prompt copied. Paste it into your agent chat on this computer.")}</p>}
      <p className="canvaslink-settings__note">{text(`Android 8+ · ${CANVASLINK_ANDROID_RELEASE.version} · экспериментальная версия`, `Android 8+ · ${CANVASLINK_ANDROID_RELEASE.version} · experimental version`)}</p>
    </section>
    <section className="canvaslink-settings__card">
      <div className="canvaslink-settings__row">
        <div><h3>{text("Доступ с Android", "Android access")}</h3><p className="canvaslink-settings__status" role="status">{status}</p></div>
        {state && (enabled ? button(text("Выключить доступ", "Turn off access"), "disable") : button(text("Включить доступ", "Enable access"), "enable", true))}
      </div>
      {!state && <p role="status">{text("Проверяем состояние…", "Checking status…")}</p>}
      {enabled && <div className="canvaslink-settings__connection">
        <ol><li>{text("Откройте CanvasLink на Android.", "Open CanvasLink on Android.")}</li>
          <li>{text("Выберите этот компьютер и введите код. IP-адрес вводить не нужно.", "Select this computer and enter the code. No IP address is needed.")}</li></ol>
        {state?.pin && seconds > 0 ? <div className="canvaslink-settings__code-block">
          <span>{text("Одноразовый код", "One-time code")}</span>
          <output className="canvaslink-settings__code" aria-label={text("Код подключения", "Pairing code")}>{state.pin.slice(0, 3)} {state.pin.slice(3)}</output>
          <small>{text(`Действует ещё ${seconds} с`, `Valid for ${seconds} s`)}</small>
        </div> : <p className="canvaslink-settings__note">{devices.length ? text("Устройство связано. Код больше не нужен до завершения сессии.", "Device paired. No code is needed until this session ends.") : text("Срок действия кода истёк. Получите новый код.", "The code expired. Get a new code.")}</p>}
        {!devices.length && button(text("Новый код", "New code"), "new-code")}
        {devices.length > 0 && <div className="canvaslink-settings__devices"><h4>{text("Связанное устройство", "Paired device")}</h4>
          {devices.map((device, index) => <p key={index}>{device.name || "Android"}</p>)}
          {button(text("Забыть устройство", "Forget device"), "revoke")}</div>}
      </div>}
    </section>
    <section className="canvaslink-settings__card canvaslink-settings__card--quiet">
      <h3>{text("Управление с планшета", "Tablet controls")}</h3>
      <p>{text("Коснитесь терминала, чтобы открыть клавиатуру. Ввод передаётся напрямую; Enter запускает команду. При потере связи ввод автоматически не повторяется. Доступ распространяется на всё это окно CanvasTTY.", "Tap a terminal to open the keyboard. Input is sent directly; Enter runs the command. Input is never automatically replayed after a disconnect. Access covers this entire CanvasTTY window.")}</p>
      <p>{text("Очки Even G2 подключаются отдельно — в разделе «Внешние интеграции». Коды и доступы независимы.", "Even G2 glasses connect separately under External integrations. Their codes and access are independent.")}</p>
    </section>
    {error && <p className="canvaslink-settings__error" role="alert">{error}</p>}
  </div>;
}
