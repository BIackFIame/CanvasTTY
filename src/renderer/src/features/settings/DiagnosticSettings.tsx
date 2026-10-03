import { useEffect, useRef, useState } from "react";
import { DIAGNOSTIC_IMAGE_MAX_BYTES, type DiagnosticAttachment, type DiagnosticConfiguration, type LocaleId } from "../../../../shared/contracts";
import { t } from "../../lib/i18n";

export function DiagnosticSettings({ locale }: { locale: LocaleId }): React.JSX.Element {
  const [configuration, setConfiguration] = useState<DiagnosticConfiguration | null>(null);
  const [description, setDescription] = useState("");
  const [sending, setSending] = useState(false);
  const [reportId, setReportId] = useState<string | null>(null);
  const [failed, setFailed] = useState<"send" | "large" | null>(null);
  const [image, setImage] = useState<{ name: string; attachment: DiagnosticAttachment } | null>(null);
  const [imageLoading, setImageLoading] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const imageInput = useRef<HTMLInputElement>(null);
  const imageReader = useRef<FileReader | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    let active = true;
    void window.canvasTTY.diagnostics.configuration().then(value => {
      if (active) setConfiguration(value);
    }).catch(() => {
      if (active) setConfiguration({ available: false, host: null });
    });
    return () => { active = false; };
  }, []);

  useEffect(() => () => {
    const reader = imageReader.current;
    imageReader.current = null;
    reader?.abort();
  }, []);

  const selectImage = (file: File | undefined): void => {
    if (!file || inFlight.current) return;
    imageReader.current?.abort();
    imageReader.current = null;
    setImage(null);
    setImageLoading(false);
    setImageFailed(false);
    const mimeType = file.type || (/\.png$/i.test(file.name) ? "image/png" : /\.jpe?g$/i.test(file.name) ? "image/jpeg" : "");
    if ((mimeType !== "image/png" && mimeType !== "image/jpeg") || !file.size || file.size > DIAGNOSTIC_IMAGE_MAX_BYTES) {
      setImageFailed(true);
      return;
    }
    const reader = new FileReader();
    imageReader.current = reader;
    setImageLoading(true);
    reader.onload = () => {
      if (imageReader.current !== reader) return;
      const result = reader.result;
      if (typeof result === "string" && result.includes(",")) {
        setImage({ name: file.name, attachment: { mimeType, base64: result.slice(result.indexOf(",") + 1) } });
      } else setImageFailed(true);
      imageReader.current = null;
      setImageLoading(false);
    };
    reader.onerror = () => {
      if (imageReader.current !== reader) return;
      imageReader.current = null;
      setImageLoading(false);
      setImageFailed(true);
    };
    reader.readAsDataURL(file);
  };

  const send = async (): Promise<void> => {
    if (inFlight.current || imageLoading || !configuration?.available || description.trim().length < 5) return;
    inFlight.current = true;
    setSending(true);
    setFailed(null);
    setReportId(null);
    const submitted = description;
    try {
      const receipt = await window.canvasTTY.diagnostics.send(submitted, image?.attachment);
      setReportId(receipt.reportId);
      setDescription(value => value === submitted ? "" : value);
      setImage(null);
      setImageFailed(false);
    } catch (error) { setFailed(String(error).includes("DIAGNOSTIC_REPORT_TOO_LARGE") ? "large" : "send"); }
    finally { inFlight.current = false; setSending(false); }
  };

  return (
    <form className="setting-group setting-group--field setting-group--stacked diagnostic-settings"
      onSubmit={event => { event.preventDefault(); void send(); }}>
      <div className="setting-group__copy">
        <h3>{t(locale, "diagnosticsTitle")}</h3>
        <p id="diagnostics-description" className="setting-group__description">{t(locale, "diagnosticsDescription")}</p>
      </div>
      <label className="diagnostic-settings__label" htmlFor="diagnostics-problem">{t(locale, "diagnosticsProblem")}</label>
      <textarea id="diagnostics-problem" rows={4} required minLength={5} maxLength={8000}
        value={description} disabled={sending} aria-describedby="diagnostics-description"
        placeholder={t(locale, "diagnosticsPlaceholder")} onChange={event => setDescription(event.target.value)} />
      <div className="diagnostic-settings__attachment">
        <input ref={imageInput} type="file" accept="image/png,image/jpeg,.png,.jpg,.jpeg" hidden disabled={sending || imageLoading}
          aria-label={t(locale, "diagnosticsAttachImage")} onChange={event => {
            selectImage(event.target.files?.[0]);
            event.target.value = "";
          }} />
        <div className="diagnostic-settings__actions">
          <button type="button" className="setting-inline-action" disabled={sending || imageLoading}
            aria-describedby="diagnostics-image-help" onClick={() => imageInput.current?.click()}>
            {t(locale, imageLoading ? "diagnosticsImageLoading" : image ? "diagnosticsReplaceImage" : "diagnosticsAttachImage")}
          </button>
          <button type="submit" className="setting-inline-action" disabled={!configuration?.available || sending || imageLoading || description.trim().length < 5}>
            {t(locale, sending ? "diagnosticsSending" : "diagnosticsSend")}
          </button>
        </div>
        <p id="diagnostics-image-help" className="setting-group__description">{t(locale, "diagnosticsImageHelp")}</p>
        {image && <figure className="diagnostic-settings__preview">
          <img src={`data:${image.attachment.mimeType};base64,${image.attachment.base64}`} width={240} height={160}
            alt={t(locale, "diagnosticsImagePreview")} onError={() => { setImage(null); setImageFailed(true); }} />
          <figcaption title={image.name}>{image.name}</figcaption>
          <button type="button" className="setting-inline-action" disabled={sending}
            onClick={() => { setImage(null); setImageFailed(false); }}>{t(locale, "diagnosticsRemoveImage")}</button>
        </figure>}
        {imageFailed && <p role="alert" className="setting-group__description">{t(locale, "diagnosticsImageFailed")}</p>}
      </div>
      {configuration && !configuration.available && <p className="setting-group__description">{t(locale, "diagnosticsUnavailable")}</p>}
      {failed && <p role="alert" className="setting-group__description">{t(locale, failed === "large" ? "diagnosticsTooLarge" : "diagnosticsFailed")}</p>}
      {reportId && <p role="status" className="setting-group__description">{t(locale, "diagnosticsSent")}: <code>{reportId}</code></p>}
    </form>
  );
}
