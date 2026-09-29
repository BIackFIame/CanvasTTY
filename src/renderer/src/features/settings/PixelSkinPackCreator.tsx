import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DEFAULT_PIXEL_SKIN_APERTURES } from "../../../../shared/contracts";
import type {
  LocaleId,
  PixelSkinAperture,
  PixelSkinApertures,
  PixelSkinPackSummary,
  PixelSkinSlot
} from "../../../../shared/contracts";
import { UiIcon } from "../../components/UiIcon";
import { pixelPackSlotForFilename } from "./pixelPackFiles";
import { PIXEL_THEME_AGENT_GUIDE_URL, pixelThemeAgentPrompt } from "./pixelThemeAgentPrompt";

const LEVELS = ["minimal", "detailed", "master"] as const;
const STATES = ["idle", "working", "completed"] as const;
const SLOTS: readonly PixelSkinSlot[] = LEVELS.flatMap((level) => STATES.map((state) => `${level}_${state}` as PixelSkinSlot)).concat("background");

function isPng(file: File): boolean {
  return file.name.toLowerCase().endsWith(".png") && (!file.type || file.type === "image/png");
}

export function PixelSkinPackCreator({ locale, onCreated }: {
  locale: LocaleId;
  onCreated(pack: PixelSkinPackSummary): void;
}): React.JSX.Element {
  const ru = locale === "ru";
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [zipFile, setZipFile] = useState<File | null>(null);
  const [files, setFiles] = useState<Partial<Record<PixelSkinSlot, File>>>({});
  const [previews, setPreviews] = useState<Partial<Record<PixelSkinSlot, string>>>({});
  const [apertures, setApertures] = useState<PixelSkinApertures>(DEFAULT_PIXEL_SKIN_APERTURES);
  const [apertureLevel, setApertureLevel] = useState<typeof LEVELS[number]>("minimal");
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [promptCopied, setPromptCopied] = useState(false);
  const bulkInput = useRef<HTMLInputElement>(null);
  const zipInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const urls = Object.fromEntries(Object.entries(files).map(([slot, file]) => [slot, URL.createObjectURL(file)]));
    setPreviews(urls);
    return () => Object.values(urls).forEach((url) => URL.revokeObjectURL(url));
  }, [files]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !installing) setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, installing]);

  const assign = (slot: PixelSkinSlot, file: File | undefined): void => {
    if (!file) return;
    if (!isPng(file)) {
      setError(ru ? "Нужен файл PNG." : "A PNG file is required.");
      return;
    }
    setFiles((current) => ({ ...current, [slot]: file }));
    setZipFile(null);
    setError(null);
  };

  const assignMany = (selected: FileList | File[]): void => {
    const assigned: Partial<Record<PixelSkinSlot, File>> = {};
    for (const file of Array.from(selected)) {
      if (!isPng(file)) continue;
      const slot = pixelPackSlotForFilename(file.name);
      if (slot) assigned[slot] = file;
    }
    if (Object.keys(assigned).length === 0) {
      setError(ru ? "Не удалось определить роли по именам PNG." : "No PNG roles were found in filenames.");
      return;
    }
    setFiles((current) => ({ ...current, ...assigned }));
    setZipFile(null);
    setError(null);
  };

  const assignZip = (file: File | undefined): void => {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".zip") || file.size > 150 * 1024 * 1024) {
      setError(ru ? "Нужен ZIP размером до 150 МБ." : "Choose a ZIP smaller than 150 MB.");
      return;
    }
    setZipFile(file);
    setFiles({});
    if (!name.trim()) setName(file.name.replace(/\.zip$/i, "").slice(0, 64));
    setError(null);
  };

  const copyAgentPrompt = (): void => {
    window.canvasTTY.clipboard.writeText(pixelThemeAgentPrompt(locale));
    setPromptCopied(true);
  };

  const openAgentGuide = (): void => {
    void window.canvasTTY.external.openUrl(PIXEL_THEME_AGENT_GUIDE_URL).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  };

  const install = async (): Promise<void> => {
    if (!name.trim() || (!zipFile && SLOTS.some((slot) => !files[slot]))) return;
    setInstalling(true);
    setError(null);
    try {
      const pack = zipFile
        ? await window.canvasTTY.pixelSkins.installZip({
          name: name.trim(), apertures, archive: new Uint8Array(await zipFile.arrayBuffer())
        })
        : await (async () => {
          const bytes = await Promise.all(SLOTS.map(async (slot) => [slot, new Uint8Array(await files[slot]!.arrayBuffer())] as const));
          return window.canvasTTY.pixelSkins.install({
            name: name.trim(), apertures,
            files: Object.fromEntries(bytes) as Record<PixelSkinSlot, Uint8Array>
          });
        })();
      onCreated(pack);
      setOpen(false);
      setName("");
      setFiles({});
      setZipFile(null);
      setApertures(DEFAULT_PIXEL_SKIN_APERTURES);
      setApertureLevel("minimal");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setInstalling(false);
    }
  };

  const count = SLOTS.filter((slot) => files[slot]).length;
  const aperture: PixelSkinAperture = apertures[apertureLevel];
  return (
    <>
      <button className="pixel-pack-create" type="button" onClick={() => { setPromptCopied(false); setOpen(true); }}>
        <UiIcon name="image-plus" size={19} />
        {ru ? "Создать пиксельную тему" : "Create pixel theme"}
      </button>
      {open && createPortal(
        <div className="pixel-pack-dialog-backdrop" onPointerDown={(event) => {
          if (event.target === event.currentTarget && !installing) setOpen(false);
        }}>
          <div className="pixel-pack-dialog" role="dialog" aria-modal="true" aria-labelledby="pixel-pack-title">
            <div className="pixel-pack-dialog__header">
              <h2 id="pixel-pack-title">{ru ? "Новая пиксельная тема" : "New pixel theme"}</h2>
              <button type="button" className="pixel-pack-dialog__close" onClick={() => setOpen(false)} disabled={installing} title={ru ? "Закрыть" : "Close"} aria-label={ru ? "Закрыть" : "Close"}>
                <UiIcon name="close" size={19} />
              </button>
            </div>
            <div className="pixel-pack-dialog__body">
              <div className="pixel-pack-dialog__topline">
                <label>
                  <span>{ru ? "Название темы" : "Theme name"}</span>
                  <input value={name} maxLength={64} autoFocus onChange={(event) => setName(event.target.value)} placeholder={ru ? "Моя тема" : "My theme"} />
                </label>
                <input ref={bulkInput} type="file" accept="image/png,.png" multiple hidden onChange={(event) => {
                  if (event.target.files) assignMany(event.target.files);
                  event.target.value = "";
                }} />
                <input ref={zipInput} type="file" accept="application/zip,.zip" hidden onChange={(event) => {
                  assignZip(event.target.files?.[0]);
                  event.target.value = "";
                }} />
                <button type="button" className="pixel-pack-dialog__bulk" onClick={() => zipInput.current?.click()}>
                  <UiIcon name="folder" size={17} />
                  {ru ? "Загрузить ZIP" : "Add ZIP"}
                </button>
                <button type="button" className="pixel-pack-dialog__bulk" onClick={() => bulkInput.current?.click()}>
                  <UiIcon name="folder" size={17} />
                  {ru ? "Загрузить PNG" : "Add PNGs"}
                </button>
              </div>
              <div className="pixel-pack-dialog__agent-actions">
                <button type="button" onClick={copyAgentPrompt} title={ru ? "Скопировать задание для агента" : "Copy agent brief"}>
                  <UiIcon name={promptCopied ? "done" : "copy"} size={16} />
                  {promptCopied ? (ru ? "Задание скопировано" : "Brief copied") : (ru ? "Скопировать задание агенту" : "Copy agent brief")}
                </button>
                <button type="button" onClick={openAgentGuide} title={ru ? "Открыть инструкцию на GitHub" : "Open the GitHub guide"}>
                  <UiIcon name="browser" size={16} />
                  {ru ? "Инструкция" : "Guide"}
                </button>
              </div>
              {zipFile ? <div className="pixel-pack-zip-selected">
                <span>{zipFile.name}</span>
                <button type="button" onClick={() => setZipFile(null)} title={ru ? "Убрать ZIP" : "Remove ZIP"} aria-label={ru ? "Убрать ZIP" : "Remove ZIP"}>
                  <UiIcon name="close" size={16} />
                </button>
              </div> : <div className="pixel-pack-grid" role="group" aria-label={ru ? "Состояния терминала" : "Terminal states"}>
                {LEVELS.map((level) => STATES.map((state) => {
                  const slot = `${level}_${state}` as PixelSkinSlot;
                  const label = `${level} · ${state}`;
                  return (
                    <label key={slot} className="pixel-pack-slot" onDragOver={(event) => event.preventDefault()} onDrop={(event) => {
                      event.preventDefault();
                      assign(slot, event.dataTransfer.files[0]);
                    }}>
                      <span className="pixel-pack-slot__label">{label}</span>
                      {previews[slot]
                        ? <img src={previews[slot]} alt="" />
                        : <span className="pixel-pack-slot__empty"><UiIcon name="image-plus" size={22} /></span>}
                      <input type="file" accept="image/png,.png" aria-label={label} onChange={(event) => {
                        assign(slot, event.target.files?.[0]);
                        event.target.value = "";
                      }} />
                    </label>
                  );
                }))}
              </div>}
              <div className={`pixel-pack-bottom${zipFile ? " pixel-pack-bottom--zip" : ""}`}>
                {!zipFile && <label className="pixel-pack-slot pixel-pack-slot--background" onDragOver={(event) => event.preventDefault()} onDrop={(event) => {
                  event.preventDefault();
                  assign("background", event.dataTransfer.files[0]);
                }}>
                  <span className="pixel-pack-slot__label">{ru ? "Фон" : "Background"}</span>
                  {previews.background
                    ? <img src={previews.background} alt="" />
                    : <span className="pixel-pack-slot__empty"><UiIcon name="image-plus" size={22} /></span>}
                  <input type="file" accept="image/png,.png" aria-label={ru ? "Фон" : "Background"} onChange={(event) => {
                    assign("background", event.target.files?.[0]);
                    event.target.value = "";
                  }} />
                </label>}
                <div className="pixel-pack-aperture" role="group" aria-label={ru ? "Отступы терминала" : "Terminal insets"}>
                  <div className="pixel-pack-aperture__levels" role="group" aria-label={ru ? "Размер терминала" : "Terminal size"}>
                    {LEVELS.map((level) => (
                      <button key={level} type="button" aria-pressed={apertureLevel === level} onClick={() => setApertureLevel(level)}>
                        {ru ? ({ minimal: "Минимал", detailed: "Детальный", master: "Мастер" })[level] : level}
                      </button>
                    ))}
                  </div>
                  {(["left", "right", "top", "bottom"] as const).map((edge) => (
                    <label key={edge}>
                      <span>{ru ? ({ left: "Слева", right: "Справа", top: "Сверху", bottom: "Снизу" })[edge]
                        : edge}</span>
                      <input type="range" min={2} max={Math.min(35, 55 - aperture[edge === "left" ? "right" : edge === "right" ? "left" : edge === "top" ? "bottom" : "top"])} value={aperture[edge]} onChange={(event) => setApertures((current) => ({
                        ...current,
                        [apertureLevel]: { ...current[apertureLevel], [edge]: Number(event.target.value) }
                      }))} />
                      <output>{aperture[edge]}%</output>
                    </label>
                  ))}
                </div>
              </div>
            </div>
            <div className="pixel-pack-dialog__footer">
              <span role="status">{error ?? (zipFile ? zipFile.name : `${count}/10 PNG`)}</span>
              <button type="button" onClick={() => void install()} disabled={installing || !name.trim() || (!zipFile && count !== SLOTS.length)}>
                <UiIcon name={installing ? "working" : "done"} size={16} />
                {installing ? (ru ? "Установка…" : "Installing…") : (ru ? "Создать тему" : "Create theme")}
              </button>
            </div>
          </div>
        </div>, document.body
      )}
    </>
  );
}
