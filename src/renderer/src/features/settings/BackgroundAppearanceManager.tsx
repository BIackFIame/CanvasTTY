import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { TerminalBackgroundPreview } from "./TerminalBackgroundPreview";
import { SettingGroup, Segmented } from "./SettingsControls";
import "./backgroundAppearanceManager.css";
import type { AppSettings, SessionSnapshot } from "../../../../shared/contracts";
import { normalizeBackgroundAppearance, type TerminalBackgroundAppearance } from "../../../../shared/terminalBackgroundAppearance";

export function BackgroundAppearanceManager({ settings, sessions, onChange, children, active = true }: {
  settings: AppSettings;
  active?: boolean;
  sessions: SessionSnapshot[];
  onChange(patch: Partial<AppSettings>): Promise<void>;
  children(appearance: TerminalBackgroundAppearance, change: (patch: Partial<TerminalBackgroundAppearance>) => void, tab: "catalog" | "adjust", disableAll: () => void): ReactNode;
}): React.JSX.Element {
  const ru = settings.locale === "ru";
  const [target, setTarget] = useState("");
  const [name, setName] = useState("");
  const [presetId, setPresetId] = useState("");
  const [error, setError] = useState("");
  const [tab, setTab] = useState("catalog");
  const scope = sessions.some(session => session.id === target) ? target : "";
  const override = scope ? settings.terminalBackgroundOverrides[scope] : undefined;
  const appearance = override ?? normalizeBackgroundAppearance(settings);
  const hasOverrides = Object.keys(settings.terminalBackgroundOverrides).length > 0;
  const overrideCount = Object.keys(settings.terminalBackgroundOverrides).length;
  const hasAnyBackground = settings.terminalBackground !== "none" || hasOverrides;

  const pendingPatch = useRef<Partial<AppSettings> | null>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushSave = useCallback(() => {
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    }
    if (pendingPatch.current) {
      const p = pendingPatch.current;
      pendingPatch.current = null;
      void onChange(p).catch(() => setError(ru ? "Не удалось сохранить настройки." : "Could not save settings."));
    }
  }, [onChange, ru]);

  useEffect(() => {
    return () => {
      flushSave();
    };
  }, [flushSave]);

  const save = async (patch: Partial<AppSettings>): Promise<boolean> => {
    flushSave();
    try { await onChange(patch); setError(""); return true; }
    catch { setError(ru ? "Не удалось сохранить настройки." : "Could not save settings."); return false; }
  };

  const change = (patch: Partial<TerminalBackgroundAppearance>): void => {
    const isImmediate = "terminalBackground" in patch || "terminalBackgroundPaused" in patch;
    const nextSettingsPatch = scope ? {
      terminalBackgroundOverrides: {
        ...settings.terminalBackgroundOverrides, [scope]: { ...appearance, ...patch },
      }
    } : (patch as Partial<AppSettings>);

    pendingPatch.current = { ...(pendingPatch.current ?? {}), ...nextSettingsPatch };

    if (isImmediate) {
      flushSave();
    } else {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      debounceTimer.current = setTimeout(flushSave, 200);
    }
  };
  const disableAll = (): void => {
    flushSave();
    void save({
      terminalBackground: "none",
      terminalBackgroundOverrides: {},
    });
  };
  const presets = settings.terminalBackgroundPresets;
  const selected = presets.find(preset => preset.id === presetId);
  return <section className="background-appearance-editor" aria-label={ru ? "Фоны терминалов" : "Terminal backgrounds"}>
    <header className="background-appearance-heading">
      <h3>{ru ? "Фоны терминалов" : "Terminal backgrounds"}</h3>
      <div className="background-appearance-navigation" role="group" aria-label={ru ? "Разделы настройки фона" : "Background settings sections"}>
        <div className="segmented">
          {[["catalog", ru ? "Каталог" : "Catalog"], ["adjust", ru ? "Настройка" : "Adjust"], ["presets", ru ? "Пресеты" : "Presets"]].map(([id, label]) =>
            <button key={id} type="button" className={`segmented__button${tab === id ? " segmented__button--active" : ""}`}
              aria-pressed={tab === id} onClick={() => setTab(id)}>{label}</button>)}
        </div>
      </div>
    </header>
    <p className="setting-group__description background-appearance-description">{ru ? "Анимированные сцены внутри окон терминалов. Выберите фон и настройте его с живым предпросмотром." : "Animated scenes inside terminal windows. Choose a background and adjust it with a live preview."}</p>
    <SettingGroup label={ru ? "Настроить фон для" : "Configure background for"}>
      <div className="terminal-background-presets">
          <select className="terminal-background-search" aria-label={ru ? "Терминал для настройки фона" : "Background target"} value={scope} onChange={event => setTarget(event.currentTarget.value)}>
            <option value="">{ru ? "Все терминалы — по умолчанию" : "All terminals — default"}</option>
            {sessions.map(session => <option key={session.id} value={session.id}>{session.title || session.cwd} · {session.id.slice(0, 8)}</option>)}
          </select>
        {scope ? <>
          <small className="setting-group__description">{override ? (ru ? "У этого терминала своё оформление." : "This terminal has its own appearance.")
            : (ru ? "Использует общие настройки. Любая правка создаст отдельное оформление." : "Uses defaults. Any change creates its own appearance.")}</small>
          <div className="terminal-background-preset-save">
            <button type="button" className="border-skin-choice terminal-background-action" disabled={!override} onClick={() => {
              const next = { ...settings.terminalBackgroundOverrides };
              delete next[scope];
              void save({ terminalBackgroundOverrides: next });
            }}>{ru ? "Использовать общие настройки" : "Use defaults"}</button>
            <button type="button" className="border-skin-choice terminal-background-action" onClick={() => {
              change({ terminalBackground: "none" });
            }}>{ru ? "Убрать фон у этого терминала" : "Remove background for this terminal"}</button>
          </div>
        </> : <>
          <button type="button" className="border-skin-choice terminal-background-action"
            disabled={!hasAnyBackground}
            onClick={disableAll}>
            {ru ? "Отключить фоны всех терминалов" : "Disable backgrounds on all terminals"}
          </button>
          {hasAnyBackground && (
            <small className="setting-group__description">
              {ru ? (hasOverrides
                ? `Внимание: у ${overrideCount} ${overrideCount === 1 ? "терминала" : "терминалов"} задан индивидуальный фон. Кнопка выше отключит фоны сразу на всех терминалах.`
                : "Отключает фоновые анимации на всех терминалах.")
                : (hasOverrides
                ? `Note: ${overrideCount} terminal(s) have individual backgrounds. The button above will disable backgrounds on all terminals.`
                : "Disables background animations on all terminals.")}
            </small>
          )}
        </>}
      </div>
    </SettingGroup>
    {tab === "catalog" ? children(appearance, change, "catalog", disableAll) : <div className="background-appearance-layout">
      <TerminalBackgroundPreview appearance={appearance} locale={settings.locale}
        synchronized={settings.terminalBackgroundSynchronized} active={active}
        session={sessions.find(session => session.id === scope) ?? sessions[0]} />
      <div className="background-appearance-controls">
    {tab === "presets" ? <>
    <SettingGroup label={ru ? "Пресеты оформления фона" : "Background appearance presets"} layout="stacked">
      <div className="terminal-background-presets">
          <select className="terminal-background-search" aria-label={ru ? "Пресет оформления фона" : "Background appearance preset"} value={selected?.id ?? ""} onChange={event => setPresetId(event.currentTarget.value)}>
            <option value="">{ru ? "Выберите пресет" : "Choose a preset"}</option>
            {presets.map(preset => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
          </select>
        <div className="segmented terminal-background-preset-actions">
          <button type="button" className="segmented__button segmented__button--active" disabled={!selected} onClick={() => { if (selected) change(selected.appearance); }}>{ru ? "Применить" : "Apply"}</button>
          <button type="button" className="segmented__button" disabled={!selected} onClick={() => {
            if (selected) void save({ terminalBackgroundPresets: presets.map(preset => preset.id === selected.id ? { ...preset, appearance: { ...appearance } } : preset) });
          }}>{ru ? "Перезаписать" : "Overwrite"}</button>
          <button type="button" className="segmented__button" disabled={!selected} onClick={() => {
            if (selected) void save({ terminalBackgroundPresets: presets.filter(preset => preset.id !== selected.id) });
          }}>{ru ? "Удалить" : "Delete"}</button>
        </div>
        <form className="terminal-background-preset-save" onSubmit={event => {
          event.preventDefault();
          if (!name.trim()) return;
          const id = crypto.randomUUID();
          void save({ terminalBackgroundPresets: [...presets, { id, name: name.trim(), appearance: { ...appearance } }] }).then(saved => {
            if (saved) { setPresetId(id); setName(""); }
          });
        }}>
          <input className="terminal-background-search" aria-label={ru ? "Название пресета" : "Preset name"} placeholder={ru ? "Название пресета" : "Preset name"} maxLength={80} value={name} onChange={event => setName(event.currentTarget.value)} />
          <button className="border-skin-choice terminal-background-action" type="submit" disabled={!name.trim()}>{ru ? "Сохранить текущий" : "Save current"}</button>
        </form>
      </div>
    </SettingGroup>
    </> : <>
    {children(appearance, change, "adjust", disableAll)}
    <SettingGroup label={ru ? "Пауза при выводе текста" : "Pause during terminal output"}
      description={ru ? "Фон замирает при поступлении текста и продолжает движение через секунду тишины." : "Freezes when text arrives and resumes after one second without output."}>
      <Segmented value={appearance.terminalBackgroundPauseOnOutput ? "on" : "off"}
        options={[["on", ru ? "Вкл" : "On"], ["off", ru ? "Выкл" : "Off"]]}
        onChange={value => change({ terminalBackgroundPauseOnOutput: value === "on" })} />
    </SettingGroup>
    <SettingGroup label={ru ? "Приглушение в фокусе (Focus Dimming)" : "Focus dimming"}
      description={ru ? "Фон плавно становится прозрачнее при активной работе в терминале для идеальной читаемости кода." : "Smoothly dims the background when the terminal is active for maximum text legibility."}>
      <Segmented value={appearance.terminalBackgroundFocusDimming ? "on" : "off"}
        options={[["on", ru ? "Вкл" : "On"], ["off", ru ? "Выкл" : "Off"]]}
        onChange={value => change({ terminalBackgroundFocusDimming: value === "on" })} />
    </SettingGroup>
    <h4 className="background-appearance-subheading">{ru ? "Для всех терминалов" : "For all terminals"}</h4>
    <SettingGroup label={ru ? "Синхронизация анимаций фонов" : "Synchronize background animations"}
      description={ru ? "Для всех терминалов с одинаковыми фоном и скоростью. После паузы фон возвращается к общему кадру." : "Shared timing for all terminals with the same background and speed. After a pause, the background rejoins the current shared frame."}>
      <Segmented value={settings.terminalBackgroundSynchronized ? "on" : "off"}
        options={[["on", ru ? "Вкл" : "On"], ["off", ru ? "Выкл" : "Off"]]}
        onChange={value => void save({ terminalBackgroundSynchronized: value === "on" })} />
    </SettingGroup>
    <SettingGroup label={ru ? "Автопауза неактивных терминалов" : "Pause inactive terminal backgrounds"}
      description={ru ? "Анимация работает только в выбранном терминале. Остальные фоны сохраняют текущий кадр до переключения на них." : "Only the selected terminal animates. Other backgrounds keep their current frame until selected."}>
      <Segmented value={settings.terminalBackgroundPauseInactive ? "on" : "off"}
        options={[["on", ru ? "Вкл" : "On"], ["off", ru ? "Выкл" : "Off"]]}
        onChange={value => void save({ terminalBackgroundPauseInactive: value === "on" })} />
    </SettingGroup>
    </>}
    </div>
    </div>}
    {error && <small role="alert">{error}</small>}
  </section>;
}
