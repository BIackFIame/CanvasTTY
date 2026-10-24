import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import type { LocaleId } from "../../../../shared/contracts";
import { UiIcon } from "../../components/UiIcon";
import {
  animatedBackgroundAgentPrompt,
  type TerminalBackgroundStyleType
} from "./animatedBackgroundPrompt";
import bladeRunnerPreview from "../../assets/ascii-animations/blade-runner-2049.webp";
import nightCoastPreview from "../../assets/ascii-animations/night-coast.webp";
import earthPreview from "../../assets/ascii-animations/earth.webp";
import "./animatedBackgroundCreator.css";

interface AnimatedBackgroundCreatorProps {
  locale: LocaleId;
}

export function AnimatedBackgroundCreator({ locale }: AnimatedBackgroundCreatorProps): React.JSX.Element {
  const ru = locale === "ru";
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState<TerminalBackgroundStyleType>("fine-dots");
  const [title, setTitle] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [pickedFile, setPickedFile] = useState<File | null>(null);
  const [copied, setCopied] = useState(false);
  const [showPromptPreview, setShowPromptPreview] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const sceneId = title.trim()
    ? title.toLowerCase().replace(/[^a-z0-9а-яё]+/g, "-").replace(/^-|-$/g, "") || "custom-scene"
    : "custom-scene";

  const generatedPrompt = animatedBackgroundAgentPrompt({
    style,
    title,
    sourceUrl: sourceUrl || (pickedFile ? pickedFile.name : ""),
    locale,
  });

  const handleCopyPrompt = async (): Promise<void> => {
    try {
      if (window.canvasTTY?.clipboard?.writeText) {
        window.canvasTTY.clipboard.writeText(generatedPrompt);
      } else if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(generatedPrompt);
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 3000);
    } catch {
      // Fallback
    }
  };

  const currentPreview =
    style === "fine-dots"
      ? bladeRunnerPreview
      : style === "dot-matrix"
      ? nightCoastPreview
      : earthPreview;

  const styleCaption =
    style === "fine-dots"
      ? ru ? "Пример: Fine Dots (Брайль 2×4)" : "Example: Fine Dots (Braille 2×4)"
      : style === "dot-matrix"
      ? ru ? "Пример: Dot Matrix (Растр 200×100)" : "Example: Dot Matrix (Raster 200×100)"
      : ru ? "Пример: Classic ASCII (Плотность)" : "Example: Classic ASCII (Density)";

  return (
    <>
      <button
        type="button"
        className="pixel-pack-create"
        onClick={() => {
          setCopied(false);
          setOpen(true);
        }}
      >
        <UiIcon name="image-plus" size={19} />
        {ru ? "Создать анимированный фон" : "Create animated background"}
      </button>

      {open &&
        createPortal(
          <div
            className="pixel-pack-dialog-backdrop"
            onPointerDown={(event) => {
              if (event.target === event.currentTarget) setOpen(false);
            }}
          >
            <div
              className="pixel-pack-dialog mascot-dialog animated-bg-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="animated-bg-dialog-title"
            >
              {/* Header */}
              <div className="pixel-pack-dialog__header">
                <h2 id="animated-bg-dialog-title">
                  {ru ? "Новый анимированный фон для терминала" : "New animated terminal background"}
                </h2>
                <button
                  type="button"
                  className="pixel-pack-dialog__close"
                  onClick={() => setOpen(false)}
                  title={ru ? "Закрыть" : "Close"}
                  aria-label={ru ? "Закрыть" : "Close"}
                >
                  <UiIcon name="close" size={19} />
                </button>
              </div>

              {/* Body */}
              <div className="pixel-pack-dialog__body">
                {/* 2-Column Guide Banner matching Mascot Dialog */}
                <div className="pixel-pack-guide mascot-dialog__guide animated-bg-guide">
                  <div>
                    <h3>
                      {ru
                        ? "Создайте анимированный фон с помощью агента"
                        : "Create an animated background with an agent"}
                    </h3>
                    <ol>
                      <li>
                        {ru
                          ? "Выберите желаемый стиль рендеринга (Fine Dots, Dot Matrix или Classic ASCII)."
                          : "Choose your preferred rendering style (Fine Dots, Dot Matrix, or Classic ASCII)."}
                      </li>
                      <li>
                        {ru
                          ? "Укажите название и при желании вставьте ссылку на видео или прикрепите файл."
                          : "Enter a title and optionally provide a video link or drop a file."}
                      </li>
                      <li>
                        {ru
                          ? "Нажмите «Скопировать задание агенту» и вставьте в чат агента. Агент сам всё скачает, сохранит полный хронометраж без обрезки и встроит готовый фон в приложение."
                          : "Click 'Copy agent prompt' and paste into your agent's chat. The agent will download the clip, preserve the full duration without cuts, and integrate the background."}
                      </li>
                    </ol>
                  </div>
                  <figure className="mascot-dialog__preview">
                    <img
                      src={currentPreview}
                      alt={style}
                      className="animated-bg-preview-img"
                    />
                    <figcaption>{styleCaption}</figcaption>
                  </figure>
                </div>

                {/* File Drop Area */}
                <label
                  className="mascot-dialog__upload animated-bg-upload"
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.preventDefault();
                    const file = event.dataTransfer.files?.[0];
                    if (file) {
                      setPickedFile(file);
                      if (!title.trim()) setTitle(file.name.replace(/\.[^.]+$/, ""));
                      setSourceUrl(file.name);
                    }
                  }}
                >
                  <UiIcon name="image-plus" size={20} />
                  <span>
                    {pickedFile
                      ? `🎬 ${pickedFile.name} (${(pickedFile.size / (1024 * 1024)).toFixed(1)} МБ)`
                      : ru
                      ? "Нажмите или перетащите видеофайл или GIF (MP4, GIF, WebM)"
                      : "Click or drop a video file or GIF (MP4, GIF, WebM)"}
                  </span>
                  <input
                    type="file"
                    accept="video/mp4,video/webm,image/gif,.mp4,.gif,.webm,.mov"
                    aria-label={ru ? "Загрузить видеофайл или GIF" : "Upload video file or GIF"}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) {
                        setPickedFile(file);
                        if (!title.trim()) setTitle(file.name.replace(/\.[^.]+$/, ""));
                        setSourceUrl(file.name);
                      }
                    }}
                  />
                </label>

                {/* 3 Styles Grid */}
                <label className="animated-bg-section-label">
                  {ru ? "1. Выберите тип рендеринга:" : "1. Choose rendering style:"}
                </label>
                <div className="animated-bg-style-grid" role="radiogroup">
                  {/* Option 1: Fine Dots */}
                  <div
                    className={`animated-bg-style-card ${style === "fine-dots" ? "animated-bg-style-card--active" : ""}`}
                    onClick={() => setStyle("fine-dots")}
                    role="radio"
                    aria-checked={style === "fine-dots"}
                    tabIndex={0}
                  >
                    <div className="animated-bg-style-card__top">
                      <span className="animated-bg-style-card__badge">
                        {ru ? "Брайль 2×4" : "Braille 2×4"}
                      </span>
                      {style === "fine-dots" && <UiIcon name="done" size={16} />}
                    </div>
                    <h4 className="animated-bg-style-card__title">1. Fine Dots</h4>
                    <p className="animated-bg-style-card__desc">
                      {ru
                        ? "Субпиксельная матрица 2×4 точки. Максимальная четкость линий и контуров. Идеально для аниме, деталей и плавной геометрии."
                        : "Sub-pixel 2×4 matrix. Highest edge crispness and geometric detail. Perfect for anime, fine art, and smooth contours."}
                    </p>
                  </div>

                  {/* Option 2: Dot Matrix */}
                  <div
                    className={`animated-bg-style-card ${style === "dot-matrix" ? "animated-bg-style-card--active" : ""}`}
                    onClick={() => setStyle("dot-matrix")}
                    role="radio"
                    aria-checked={style === "dot-matrix"}
                    tabIndex={0}
                  >
                    <div className="animated-bg-style-card__top">
                      <span className="animated-bg-style-card__badge">
                        {ru ? "Растр 200×100" : "Raster 200×100"}
                      </span>
                      {style === "dot-matrix" && <UiIcon name="done" size={16} />}
                    </div>
                    <h4 className="animated-bg-style-card__title">2. Dot Matrix</h4>
                    <p className="animated-bg-style-card__desc">
                      {ru
                        ? "Полутоновый экран из точек « ·•●» с дизерингом Байера 4×4. Сочный аркадный ретро-стиль 2:1, идеален для киберпанка и пейзажей."
                        : "Halftone dot screen with 4-level ' ·•●' and 4x4 Bayer dithering. Vibrant 2:1 arcade retro display, ideal for cityscapes and sunsets."}
                    </p>
                  </div>

                  {/* Option 3: Classic ASCII */}
                  <div
                    className={`animated-bg-style-card ${style === "classic-ascii" ? "animated-bg-style-card--active" : ""}`}
                    onClick={() => setStyle("classic-ascii")}
                    role="radio"
                    aria-checked={style === "classic-ascii"}
                    tabIndex={0}
                  >
                    <div className="animated-bg-style-card__top">
                      <span className="animated-bg-style-card__badge">
                        {ru ? "Символы плотности" : "Density chars"}
                      </span>
                      {style === "classic-ascii" && <UiIcon name="done" size={16} />}
                    </div>
                    <h4 className="animated-bg-style-card__title">3. Classic ASCII</h4>
                    <p className="animated-bg-style-card__desc">
                      {ru
                        ? "Аутентичный текстовый арт на основе символов яркости « .:-=+*#%@». Классическая атмосфера BBS и монохромных терминалов."
                        : "Authentic text art based on character brightness ramp. Classic BBS and green/amber terminal hacker aesthetics."}
                    </p>
                  </div>
                </div>

                {/* Input Fields */}
                <div className="animated-bg-inputs">
                  <div className="animated-bg-field">
                    <label htmlFor="animated-bg-source">
                      {ru ? "2. Ссылка на видео или путь к файлу (опционально):" : "2. Video URL or file path (optional):"}
                    </label>
                    <input
                      id="animated-bg-source"
                      className="terminal-background-search"
                      type="text"
                      placeholder={
                        ru
                          ? "https://www.youtube.com/watch?v=... или C:\\Users\\...\\video.mp4"
                          : "https://www.youtube.com/watch?v=... or C:\\Users\\...\\video.mp4"
                      }
                      value={sourceUrl}
                      onChange={(event) => setSourceUrl(event.target.value)}
                    />
                    <small>
                      {ru
                        ? "Агент сам скачает ролик по ссылке через yt-dlp/curl или обработает локальный файл."
                        : "The agent will download via yt-dlp/curl or read the local file directly."}
                    </small>
                  </div>

                  <div className="animated-bg-field">
                    <label htmlFor="animated-bg-title">
                      {ru ? "3. Название фона в каталоге:" : "3. Background title in catalog:"}
                    </label>
                    <input
                      id="animated-bg-title"
                      className="terminal-background-search"
                      type="text"
                      placeholder={ru ? "Например: Киберпанк город в дожде" : "For example: Cyberpunk City Rain"}
                      maxLength={64}
                      value={title}
                      onChange={(event) => setTitle(event.target.value)}
                    />
                    <small>
                      {ru ? `Идентификатор сцены: "${sceneId}"` : `Scene identifier: "${sceneId}"`}
                    </small>
                  </div>
                </div>

                {/* Agent Action Buttons */}
                <div className="pixel-pack-dialog__agent-actions">
                  <button
                    type="button"
                    className="border-skin-choice"
                    style={{
                      background: copied ? "var(--primary)" : "var(--surface-soft)",
                      color: copied ? "#ffffff" : "var(--text)",
                      fontWeight: 700,
                    }}
                    onClick={() => void handleCopyPrompt()}
                  >
                    <UiIcon name={copied ? "done" : "copy"} size={16} />
                    {copied
                      ? ru
                        ? "✓ Задание скопировано в буфер!"
                        : "✓ Prompt copied to clipboard!"
                      : ru
                      ? "Скопировать задание агенту"
                      : "Copy agent prompt"}
                  </button>

                  <button
                    type="button"
                    className="border-skin-choice"
                    onClick={() => setShowPromptPreview((current) => !current)}
                  >
                    <UiIcon name="file-text" size={16} />
                    {showPromptPreview
                      ? ru
                        ? "Скрыть текст задания"
                        : "Hide prompt text"
                      : ru
                      ? "Посмотреть текст задания"
                      : "View prompt text"}
                  </button>
                </div>

                {/* Expandable Prompt Preview */}
                {showPromptPreview && (
                  <div className="animated-bg-prompt-box">
                    {generatedPrompt}
                  </div>
                )}
              </div>

              {/* Footer */}
              <div className="pixel-pack-dialog__footer">
                <span role="status" style={{ fontSize: "12px", color: "var(--text-muted-on-dark)" }}>
                  {ru
                    ? `Выбран стиль: ${style === "fine-dots" ? "Fine Dots (Брайль 2×4)" : style === "dot-matrix" ? "Dot Matrix (Растр 200×100)" : "Classic ASCII"} • ID: "${sceneId}"`
                    : `Selected style: ${style} • ID: "${sceneId}"`}
                </span>
                <button
                  type="button"
                  style={{
                    minHeight: "36px",
                    padding: "8px 20px",
                    fontWeight: 600,
                    borderRadius: "6px",
                    border: "1px solid var(--primary)",
                    background: "var(--primary)",
                    color: "#ffffff",
                    cursor: "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "7px",
                  }}
                  onClick={() => {
                    void handleCopyPrompt();
                    setOpen(false);
                  }}
                >
                  <UiIcon name="done" size={16} />
                  {ru ? "Скопировать и закрыть" : "Copy & Close"}
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}
    </>
  );
}
