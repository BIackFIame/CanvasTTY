import type { LocaleId } from "../../../../shared/contracts";

export type TerminalBackgroundStyleType = "fine-dots" | "dot-matrix" | "classic-ascii";

export interface BackgroundPromptOptions {
  style: TerminalBackgroundStyleType;
  title?: string;
  sourceUrl?: string;
  locale?: LocaleId;
}

const RU_MAP: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "yo", ж: "zh",
  з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o",
  п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts",
  ч: "ch", ш: "sh", щ: "shch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya"
};

export function transliterateToId(text: string): string {
  const lower = text.toLowerCase();
  let result = "";
  for (const ch of lower) {
    if (RU_MAP[ch] !== undefined) {
      result += RU_MAP[ch];
    } else if (/[a-z0-9]/.test(ch)) {
      result += ch;
    } else {
      result += "-";
    }
  }
  return result.replace(/-+/g, "-").replace(/^-|-$/g, "") || "custom-scene";
}

export function animatedBackgroundAgentPrompt(options: BackgroundPromptOptions): string {
  const { style, title, sourceUrl, locale = "ru" } = options;
  const ru = locale === "ru";
  const bgTitle = title?.trim() || (ru ? "Мой анимированный фон" : "My Animated Background");
  const id = transliterateToId(bgTitle);
  const sourceHint = sourceUrl?.trim()
    ? (ru ? `Источник видео/GIF: ${sourceUrl.trim()}` : `Video/GIF source: ${sourceUrl.trim()}`)
    : (ru ? "Источник: используй прикреплённый к сообщению видеофайл, GIF или ссылку." : "Source: use the attached video file, GIF, or URL.");

  if (ru) {
    let styleRules = "";
    if (style === "fine-dots") {
      styleRules = `Режим рендеринга: FINE DOTS (Субпиксельная матрица Брайля 2×4):
- meta: { cols: 140..192 (пропорционально видео), rows: cols / (2 * aspect), cell: 2, fineDots: true, contain: true, ground: "#07090f", palette: clip.palette }
- Символы: 256 масок Брайля (0x2800..0x28FF), гамма 0.62, субпиксели 2×4 в каждой ячейке.
- Палитра: 256 цветов K-Means, где palette[0] = "#07090f" (ground-цвет).`;
    } else if (style === "dot-matrix") {
      styleRules = `Режим рендеринга: DOT MATRIX (Растровый полутоновый экран 2:1):
- meta: { cols: 200, rows: 100, cell: 1, ground: "#07090f", palette: clip.palette }
- Символы: 4-уровневый полутоновый растр " ·•●" с дизерингом матрицей Байера 4×4.
- Палитра: 64 сочных цвета K-Means, где palette[0] = "#07090f".`;
    } else {
      styleRules = `Режим рендеринга: CLASSIC ASCII (Символьная плотность):
- meta: { cols: 140..180, rows: cols / (2 * aspect), cell: 2, ground: "#07090f", contain: true, palette: clip.palette }
- Символы: рампа плотности ' .:-=+*#%@' с квантизацией яркости пикселей.
- Палитра: 32 контрастных цвета с palette[0] = "#07090f".`;
    }

    return `Создай новый анимированный терминальный фон для CanvasTTY ASCII Lab.

Название: "${bgTitle}"
ID фона: "${id}"
${sourceHint}

ТЕХНИЧЕСКИЙ РЕГЛАМЕНТ:
${styleRules}

КЛЮЧЕВЫЕ ТРЕБОВАНИЯ:
1. ПОЛНЫЙ ХРОНОМЕТРАЖ: Никакой обрезки видеоряда! Захвати ролик целиком от начала до конца с равномерной частотой 12–15 fps (длинные видео могут содержать 100–250 кадров).
2. СТРУКТУРА ФАЙЛОВ:
   - RLE-данные: "src/renderer/src/vendor/ascii-rest/data/${id}.json"
   - Модуль сцены: "src/renderer/src/vendor/ascii-rest/pieces/${id}.js" (импортирует data и вызывает createVideoAsciiClip(clip))
   - Статический постер WebP (400x200): "src/renderer/src/assets/ascii-posters/${id}.webp"
   - Анимированное превью WebP (16 сэмплов по всей длине): "src/renderer/src/assets/ascii-animations/${id}.webp"
3. РЕГИСТРАЦИЯ:
   - Зарегистрируй фон в "src/shared/terminalBackgroundCatalog.ts" в категории "scenes"
   - Добавь русское название в "src/renderer/src/features/settings/TerminalBackgroundChoices.tsx"
   - Обнови счетчики в тестах "tests/terminal-ascii-background.test.mjs" и "tests/terminal-background-choices.test.mjs"
4. ПРОВЕРКА И ДЕПЛОЙ:
   - Прогони тесты: "node --test tests/*background*.test.mjs"
   - Выполни сборку: "./node_modules/.bin/electron-vite.cmd build"
   - Перенеси артефакты в рабочее приложение: "node ../prepare-copy.mjs"

Приступай к выполнению, сделай всё автономно под ключ!`;
  }

  // English prompt
  let styleRulesEn = "";
  if (style === "fine-dots") {
    styleRulesEn = `Rendering Mode: FINE DOTS (2×4 Braille subpixel matrix):
- meta: { cols: 140..192, rows: cols / (2 * aspect), cell: 2, fineDots: true, contain: true, ground: "#07090f", palette: clip.palette }
- Glyphs: 256 Braille masks (0x2800..0x28FF), gamma 0.62, 2x4 subpixels per cell.
- Palette: 256 colors via K-Means with palette[0] = "#07090f".`;
  } else if (style === "dot-matrix") {
    styleRulesEn = `Rendering Mode: DOT MATRIX (2:1 Halftone screen):
- meta: { cols: 200, rows: 100, cell: 1, ground: "#07090f", palette: clip.palette }
- Glyphs: 4-level halftone ramp " ·•●" with 4x4 Bayer matrix dithering.
- Palette: 64 vibrant colors with palette[0] = "#07090f".`;
  } else {
    styleRulesEn = `Rendering Mode: CLASSIC ASCII (Character density):
- meta: { cols: 140..180, rows: cols / (2 * aspect), cell: 2, ground: "#07090f", contain: true, palette: clip.palette }
- Glyphs: Density ramp ' .:-=+*#%@' mapped to luminance.
- Palette: 32 high-contrast colors with palette[0] = "#07090f".`;
  }

  return `Create a new animated terminal background for CanvasTTY ASCII Lab.

Title: "${bgTitle}"
Scene ID: "${id}"
${sourceHint}

TECHNICAL SPECIFICATIONS:
${styleRulesEn}

KEY REQUIREMENTS:
1. FULL TIMELINE: Do not truncate the animation! Sample the entire video uniformly at 12–15 fps (can be 100–250 frames for longer clips).
2. FILE STRUCTURE:
   - RLE data: "src/renderer/src/vendor/ascii-rest/data/${id}.json"
   - Scene piece: "src/renderer/src/vendor/ascii-rest/pieces/${id}.js" (imports JSON and returns createVideoAsciiClip(clip))
   - Static WebP poster (400x200): "src/renderer/src/assets/ascii-posters/${id}.webp"
   - Animated WebP preview (16 uniform samples): "src/renderer/src/assets/ascii-animations/${id}.webp"
3. REGISTRATION:
   - Register in "src/shared/terminalBackgroundCatalog.ts" under "scenes"
   - Add label in "src/renderer/src/features/settings/TerminalBackgroundChoices.tsx"
   - Bump catalog counts in "tests/terminal-ascii-background.test.mjs" and "tests/terminal-background-choices.test.mjs"
4. BUILD & DEPLOY:
   - Verify tests: "node --test tests/*background*.test.mjs"
   - Build bundle: "./node_modules/.bin/electron-vite.cmd build"
   - Copy to runtime: "node ../prepare-copy.mjs"

Execute autonomously and verify the build!`;
}
