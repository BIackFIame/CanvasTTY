import { useRef, useState, type CSSProperties } from "react";
import type { LocaleId, SessionSnapshot } from "../../../../shared/contracts";
import type { TerminalBackgroundAppearance } from "../../../../shared/terminalBackgroundAppearance";
import { AsciiTerminalBackground } from "../terminal/AsciiTerminalBackground";
import { Segmented } from "./SettingsControls";
import "./terminalBackgroundPreview.css";

type PreviewShape = "terminal" | "wide" | "square" | "tall";

export function backgroundPreviewViewport(shape: PreviewShape, size?: { width: number; height: number }): { width: number; height: number } {
  if (shape === "wide") return { width: 960, height: 540 };
  if (shape === "square") return { width: 720, height: 720 };
  if (shape === "tall") return { width: 540, height: 900 };
  return { width: Math.max(240, Math.round(size?.width ?? 960)), height: Math.max(160, Math.round(size?.height ?? 600)) };
}

export function TerminalBackgroundPreview({ appearance, locale, synchronized, active, session }: {
  appearance: TerminalBackgroundAppearance;
  locale: LocaleId;
  synchronized: boolean;
  active: boolean;
  session?: SessionSnapshot;
}): React.JSX.Element {
  const ru = locale === "ru";
  const [shape, setShape] = useState<PreviewShape>("terminal");
  const [outputCount, setOutputCount] = useState(0);
  const outputActivity = useRef<(() => void) | null>(null);
  const viewport = backgroundPreviewViewport(shape, session?.size);
  const readable = appearance.terminalBackgroundReadability;
  const lines = ["preview$ npm run build", ru ? "Сборка завершена успешно." : "Build completed successfully.",
    outputCount ? (ru ? `Получен вывод #${outputCount}` : `Output received #${outputCount}`) : "preview$ _"];
  return <aside className="terminal-background-live-preview" aria-label={ru ? "Предпросмотр фона терминала" : "Terminal background preview"}>
    <h3>{ru ? "Предпросмотр" : "Preview"}</h3>
    <Segmented value={shape}
      options={[["terminal", ru ? "Окно" : "Window"], ["wide", "16:9"], ["square", "1:1"], ["tall", "3:5"]]}
      onChange={value => setShape(value as PreviewShape)} />
    <div className="terminal-background-live-preview__window">
      <div className="terminal-background-live-preview__title"><span aria-hidden="true">&gt;_</span> {ru ? "Пример терминала" : "Terminal example"}</div>
      <div className="terminal-background-live-preview__frame">
        <div className={`terminal-background-live-preview__surface terminal-card__surface--ascii${readable ? " terminal-background-live-preview__surface--readable" : ""}`}
          style={{ "--preview-aspect": viewport.width / viewport.height,
            "--terminal-text-backdrop-strength": appearance.terminalBackgroundReadabilityStrength / 100 } as CSSProperties}>
          {appearance.terminalBackground !== "none" && <AsciiTerminalBackground
            scene={appearance.terminalBackground} brightness={appearance.terminalBackgroundBrightness}
            contrast={appearance.terminalBackgroundContrast} saturation={appearance.terminalBackgroundSaturation}
            paused={appearance.terminalBackgroundPaused} speed={appearance.terminalBackgroundSpeed}
            scale={appearance.terminalBackgroundScale} offsetX={appearance.terminalBackgroundOffsetX}
            offsetY={appearance.terminalBackgroundOffsetY} pauseOnOutput={appearance.terminalBackgroundPauseOnOutput}
            synchronized={synchronized} live={active} outputActivity={outputActivity} viewport={viewport} />}
          <pre className="terminal-background-live-preview__text" aria-label={ru ? "Пример текста" : "Sample text"}>
            {lines.map((line, index) => <div key={index}>{line.split(/(\s+)/).map((part, token) =>
              part.trim() ? <span key={token}>{part}</span> : part)}</div>)}
          </pre>
        </div>
      </div>
    </div>
    <p className="setting-group__description">{viewport.width} × {viewport.height} · {ru ? "Изменения видны сразу" : "Changes appear immediately"}</p>
    {appearance.terminalBackground === "none" && <p className="setting-group__description">{ru ? "Выберите фон в каталоге." : "Choose a background in the catalog."}</p>}
    <button type="button" className="border-skin-choice terminal-background-action"
      disabled={!active || appearance.terminalBackground === "none" || !appearance.terminalBackgroundPauseOnOutput || appearance.terminalBackgroundPaused}
      onClick={() => { outputActivity.current?.(); setOutputCount(count => count + 1); }}>
      {ru ? "Проверить паузу при выводе" : "Test pause during output"}
    </button>
  </aside>;
}
