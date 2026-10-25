import { memo, useEffect, useRef, useState } from "react";
import type { LocaleId } from "../../../../shared/contracts";
import { TERMINAL_BACKGROUND_CATALOG, type TerminalBackgroundId } from "../../../../shared/terminalBackground";
import "./terminalBackgroundChoices.css";

const RUSSIAN_NAMES: Partial<Record<TerminalBackgroundId, string>> = {
  "a0": "a0 (Блестящая буква)",
  "agentmail": "AgentMail (Шпион в шляпе)",
  "almalinux": "AlmaLinux (Хоровод цветов)",
  "alpine-dawn": "Альпийский рассвет",
  "alpine-linux": "Alpine Linux (Легче воздуха)",
  "amer-fort": "Форт Амер (Индия)",
  "analog-clock": "Стрелочные часы (Тик-так)",
  "apple": "Apple (Надкусанное яблоко)",
  "aquarium": "Аквариум с рыбками и пузырями",
  "arch-linux": "Arch Linux (I use Arch btw)",
  "aurora": "Северное сияние над тайгой",
  "aurora-fjord": "Сияние над фьордом",
  "autumn": "Autumn (Осенний листок)",
  "bar-chart": "Столбчатая диаграмма (Рост)",
  "big-text": "Гигантский баннер",
  "black-hole": "Чёрная дыра Гаргантюа",
  "black-prism": "Чёрная призма",
  "bonsai": "Дерево бонсай (Смена сезонов)",
  "boot-log": "Лог загрузки ядра Linux",
  "bouncing-balls": "Прыгающие резиновые мячи",
  "box-frames": "Рамки и границы ASCII",
  "butterfly": "Порхающая бабочка",
  "c": "Язык Си (Segfault неизбежен)",
  "calendar": "Настенный терминальный календарь",
  "campfire": "Уютный костёр с искрами",
  "candle": "Мерцающая свеча",
  "candlesticks": "Японские свечи (Трейдинг)",
  "cat": "Спящий рыжий кот",
  "centos": "CentOS (Покойся с миром)",
  "chat": "Переписка в мессенджере (Печатает...)",
  "cherry-blossom": "Цветущая сакура (Лепестки на ветру)",
  "chladni": "Фигуры Хладни (Песок на пластине)",
  "clojure": "Clojure (Скобочный рай)",
  "cloud-sea": "Море облаков",
  "cloudflare": "Cloudflare (Ошибка 502)",
  "coderabbit": "CodeRabbit (Кролик-ревьюер)",
  "coffee": "Чашка горячего кофе (Дымок)",
  "collabute": "Collabute (Инь и Ян)",
  "command-city": "Кибер-город",
  "command-code": "Command Code (Кнопка Cmd)",
  "contour-map": "Топографическая карта высот",
  "cpp": "C++ (Утечка памяти)",
  "cpu-meters": "Загрузка CPU (htop в стиле ASCII)",
  "csharp": "C# (Любимый шарп)",
  "css": "CSS (С центрированием по вертикали)",
  "cube": "Вращающийся 3D-куб",
  "dart": "Dart (Флаттерный дротик)",
  "databuddy": "DataBuddy (Заяц с данными)",
  "debian": "Debian (Стабильный как дед)",
  "deep-reef": "Глубоководный риф",
  "deepin": "Deepin (Китайский вихрь)",
  "desert-night": "Пустыня под звёздами",
  "digital-clock": "Электронные часы 24ч",
  "dissolve": "Рассыпающиеся слова",
  "dividers": "Декоративные разделители",
  "dna-helix": "Двойная спираль ДНК",
  "donut": "Вращающийся бублик (donut.c)",
  "doom-fire": "Огонь из DOOM (PSX Fire)",
  "double-pendulum": "Хаотический двойной маятник",
  "earth": "Вращающаяся Земля",
  "earthrise": "Восход Земли над Луной",
  "eclipse": "Солнечное затмение (Корона)",
  "edge-orbit": "На краю орбиты",
  "elementary-os": "elementary OS (Как на Маке)",
  "elixir": "Elixir (Фиолетовая капля)",
  "elm": "Elm (Танграм без ошибок в рантайме)",
  "endeavouros": "EndeavourOS (Фиолетовый парус)",
  "epicycles": "Эпициклы (Круги рисуют звезду)",
  "equalizer": "Музыкальный эквалайзер",
  "erlang": "Erlang (99.9999999% надёжности)",
  "falling-sand": "Сыпучий песок",
  "fedora": "Fedora (Синяя шляпа)",
  "fern": "Папоротник Барнсли",
  "ferris-wheel": "Колесо обозрения",
  "file-tree": "Дерево файлов проекта",
  "fireflies": "Светлячки в ночной траве",
  "fireworks": "Праздничный салют",
  "flag": "Флаг развевается на ветру",
  "flow-field": "Векторное поле частиц",
  "form-controls": "Консольная форма ввода",
  "fountain": "Струи фонтана",
  "fox": "Лисичка, свернувшаяся калачиком",
  "fractal-tree": "Фрактальное дерево на ветру",
  "galaxy": "Спиральная галактика",
  "gangaur-ghat": "Гангаур-гхат",
  "gauge": "Стрелочный спидометр / Датчик",
  "gentoo": "Gentoo (Компилирую всю жизнь)",
  "git-graph": "Ветвление Git (git log --graph)",
  "glider-gun": "Пушка планеров Госпера",
  "glitch": "Глитч / Битые пиксели текста",
  "glxgears": "Шестерёнки GLXGears (Тест FPS)",
  "go": "Go (Суслик Гофер)",
  "green-storm": "Изумрудная буря",
  "greptile": "Greptile (Зелёный кубик)",
  "gyroscope": "Гироскоп в кардановом подвесе",
  "harmonograph": "Гармонограф (Кружевные кривые)",
  "haskell": "Haskell (Монады — это моноиды)",
  "hawa-mahal": "Дворец ветров (Хава-Махал)",
  "heart": "Биение 3D-сердца",
  "heartbeat": "Пульс / Кардиограмма (ЭКГ)",
  "heatmap": "Гитхаб-контрибуции (Зелёная сетка)",
  "helium": "Helium (Синяя звёздочка)",
  "helixdb": "HelixDB (Спираль базы данных)",
  "helmcode": "Helmcode (Фиолетовый шлем)",
  "hilbert-curve": "Кривая Гильберта",
  "hourglass": "Песочные часы (Время утекает)",
  "html": "HTML (Я программист, я сделал сайт)",
  "icosahedron": "Проволочный икосаэдр",
  "jal-mahal": "Джал-Махал",
  "java": "Java (NullPointerException)",
  "javascript": "JavaScript (undefined is not a function)",
  "jellyfish": "Парящая глубоководная медуза",
  "julia": "Julia (Быстрее ветра)",
  "julia-set": "Фрактал Жюлиа",
  "jungle-falls": "Водопад в джунглях",
  "kali-linux": "Kali Linux (Мамин хакер)",
  "keiki": "Keiki (Детская лошадка-качалка)",
  "kite": "Воздушный змей на ветру",
  "kite-festival": "Фестиваль воздушных змеев",
  "kotlin": "Kotlin (Прощай, бойлерплейт)",
  "kyoto-dusk": "Сумерки в Киото",
  "lake-pichola": "Озеро Пичола",
  "landscape": "Горное озеро (День и ночь)",
  "langtons-ant": "Муравей Лэнгтона",
  "lantern-lake": "Озеро с фонариками",
  "lava-lamp": "Лавовая лампа (Релакс)",
  "lava-wall": "Лавовая стена",
  "lighthouse": "Маяк на скалах (Луч во тьме)",
  "lightning": "Грозовая молния в тучах",
  "linux-mint": "Linux Mint (Зелёный лист)",
  "lorenz": "Аттрактор Лоренца (Крылья бабочки)",
  "lua": "Lua (Массивы с единицы!)",
  "mandelbrot": "Фрактал Мандельброта (Зум в бездну)",
  "manjaro": "Manjaro (Зелёные кирпичики)",
  "marine-drive": "Набережная Марин-Драйв",
  "marquee": "Бегущая строка (Табло)",
  "matrix-rain": "Матрица: цифровой дождь",
  "maze": "Генерация лабиринта",
  "mintlify": "Mintlify (Мятный лист)",
  "misty-forest": "Туманный лес",
  "mobius-strip": "Лента Мёбиуса",
  "moon-phases": "Фазы Луны (От новолуния к полнолунию)",
  "morse": "Азбука Морзе (Точки и тире)",
  "newtons-cradle": "Колыбель Ньютона (Стук шаров)",
  "night-coast": "Ночное побережье",
  "night-highway": "Ночное шоссе",
  "nixos": "NixOS (Декларативный ад)",
  "not-found": "Ошибка 404 (Летающее привидение)",
  "ocaml": "OCaml (Французская типизация)",
  "ocean-sunset": "Закат над океаном",
  "omarchy": "Omarchy (Зелёные скобки)",
  "opensuse": "openSUSE (Зелёный хамелеон)",
  "orchid": "Orchid (Орхидея с лепестками)",
  "owl": "Сова на ветке (Моргает)",
  "pendulum-wave": "Волна маятников",
  "perl": "Perl (Регулярка на регулярке)",
  "php": "PHP (Умер в 2005, живее всех живых)",
  "pipeline": "CI/CD Pipeline (Сборка упала, потом зелёная)",
  "planet": "Сатурн с кольцами",
  "planet-scale": "Планетарный масштаб",
  "planetscale": "PlanetScale (База данных MySQL)",
  "plasma": "Олдскульная демосцен-плазма",
  "playstation": "PlayStation (Легендарная плойка PS)",
  "plucked-string": "Колебание струны (Замедленная съёмка)",
  "polar": "Polar (Полярная звезда)",
  "pond-ripples": "Круги на пруду от капель дождя",
  "pop-os": "Pop!_OS (Робот System76)",
  "prism-city": "Призматический город",
  "progress-bar": "Индикатор загрузки (99%)",
  "python": "Python (Две змейки без точки с запятой)",
  "r": "Язык R (Статистика и графики)",
  "radar": "Круговой военный радар",
  "rain": "Дождь по стеклу",
  "reaction-diffusion": "Реакция-диффузия Тьюринга",
  "red-hat": "Red Hat (Красная шляпа)",
  "rocket": "Запуск ракеты на орбиту",
  "rocky-linux": "Rocky Linux (Крепкий орешек)",
  "rotozoomer": "Ротозумер (Пьяная стена)",
  "ruby": "Ruby (Блестящий рубин)",
  "rule-30": "Правило 30 (Клеточный автомат Вольфрама)",
  "ruled-mountains": "Горы из линий (Плавный полёт)",
  "rust": "Rust (Перепиши всё на Rust!)",
  "salt-flat": "Солончак",
  "saptarishi": "Созвездие Большой Медведицы",
  "saturn-rise": "Восход Сатурна",
  "scala": "Scala (Сложно, но модно)",
  "scramble": "Дешифровка текста (Хакер)",
  "sea-swell": "Океанская зыбь и парусник",
  "sierpinski": "Треугольник Серпинского",
  "skeleton": "Скелетон-загрузчик (Шиммер)",
  "skyline": "Ночной мегаполис (Огни окон)",
  "smoke": "Клубы дыма",
  "snake": "Змейка ползёт (Ш-ш-ш)",
  "snow-train": "Поезд в снегу",
  "snowfall": "Тихий снегопад и сугробы",
  "solar-system": "Солнечная система (Орбиты планет)",
  "sparkline": "Живые графики (Спарклайны)",
  "sparks": "Искры от болгарки",
  "spider": "Паук спускается на паутине",
  "spinners": "12 терминальных спиннеров загрузки",
  "split-flap": "Табло аэропорта (Шуршание букв)",
  "spring": "Пружина с грузиком",
  "starfield": "Варп-прыжок сквозь звёзды",
  "starlings": "Стая скворцов (Муравейник птиц)",
  "storm-plains": "Штормовая равнина",
  "sundial": "Солнечные часы Самрат Янтра",
  "sunrise": "Рассвет над морским горизонтом",
  "supabase": "Supabase (Зелёная молния)",
  "supermemory": "Supermemory (Второй мозг)",
  "svelte": "Svelte (Оранжевая лента без Virtual DOM)",
  "swift": "Swift (Красногрудая ласточка)",
  "synthwave": "Синтвейв: неоновое солнце и сетка",
  "taj-dawn": "Рассвет у Тадж-Махала",
  "terminal": "Терминальная сессия (Команды и вывод)",
  "tesseract": "Четырёхмерный гиперкуб (Тессеракт)",
  "three-body": "Задача трёх тел (Орбита-восьмёрка)",
  "tokyo-rain": "Токио под дождём",
  "torus-knot": "Торический узел",
  "train": "Поезд на рельсах с дымом",
  "tunnel": "Психоделический 3D-туннель",
  "tux": "Пингвин Tux (Батя Linux)",
  "tv-static": "Белый шум телевизора (Рябь)",
  "twisted-ring": "Скрученное кольцо с одной гранью",
  "typescript": "TypeScript (any any any)",
  "typewriter": "Печатная машинка (Стук клавиш)",
  "ubuntu": "Ubuntu (Человечность к другим)",
  "uptime-bar": "Аптайм серверов 99.9%",
  "varanasi-ghats": "Гхаты Варанаси",
  "vercel": "Vercel (Чёрный треугольник деплоя)",
  "vinyl": "Виниловая пластинка под иглой",
  "void-linux": "Void Linux (Быстрее systemd)",
  "volcano-night": "Ночной вулкан",
  "voronoi": "Диаграмма Вороного",
  "wave-interference": "Интерференция волн на воде",
  "wave-text": "Текстовая волна",
  "whale": "Кит ныряет в бездну",
  "wind": "Порывы ветра (Стримы воздуха)",
  "windmill": "Старая ветряная мельница",
  "zig": "Zig (Ручное управление памятью)",
  "zorin-os": "Zorin OS (Переход с Windows)",
};

const CATEGORIES = [
  ["scenes", "Сцены", "Scenes"], ["ui", "Интерфейсы", "UI"],
  ["data", "Данные", "Data"], ["type", "Типографика", "Typography"],
  ["logos", "Логотипы", "Logos"], ["companies", "Компании", "Companies"],
  ["distros", "Дистрибутивы", "Distros"], ["shapes", "Фигуры", "Shapes"],
  ["space", "Космос", "Space"], ["physics", "Физика", "Physics"],
  ["nature", "Природа", "Nature"], ["creatures", "Существа", "Creatures"],
  ["objects", "Предметы", "Objects"], ["generative", "Генеративная графика", "Generative"],
  ["effects", "Эффекты", "Effects"]
] as const;

const POSTERS = import.meta.glob<string>("../../assets/ascii-posters/*.webp", { eager: true, query: "?url", import: "default" });
const ANIMATIONS = import.meta.glob<string>("../../assets/ascii-animations/*.webp", { eager: true, query: "?url", import: "default" });

const ScenePreview = memo(function ScenePreview({ scene, animated }: { scene: Exclude<TerminalBackgroundId, "none">; animated: boolean }): React.JSX.Element {
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    if (!animated) { setPlaying(false); return; }
    const timer = window.setTimeout(() => setPlaying(true), 200);
    return () => window.clearTimeout(timer);
  }, [animated]);
  return <BackgroundPreviewFrame scene={scene} playing={animated && playing} />;
});

export function BackgroundPreviewFrame({ scene, playing }: { scene: Exclude<TerminalBackgroundId, "none">; playing: boolean }): React.JSX.Element {
  return <div className="border-skin-preview terminal-background-preview" aria-hidden="true">
    <img src={playing ? ANIMATIONS[`../../assets/ascii-animations/${scene}.webp`] : POSTERS[`../../assets/ascii-posters/${scene}.webp`]}
      alt="" decoding="async" draggable={false} />
  </div>;
}

export function TerminalBackgroundChoices({ locale, value, paused, favorites, onFavoritesChange, deleted = [], onDeletedChange, onChange, onDisableAll }: {
  locale: LocaleId;
  value: TerminalBackgroundId;
  paused: boolean;
  favorites: Exclude<TerminalBackgroundId, "none">[];
  onFavoritesChange(value: Exclude<TerminalBackgroundId, "none">[]): void;
  deleted?: string[];
  onDeletedChange?(value: string[]): void;
  onChange(value: TerminalBackgroundId): void;
  onDisableAll?(): void;
}): React.JSX.Element {
  const [hovered, setHovered] = useState<TerminalBackgroundId | null>(null);
  const [focused, setFocused] = useState<TerminalBackgroundId | null>(null);
  const [query, setQuery] = useState("");
  const [scrolling, setScrolling] = useState(false);
  const scrollTimer = useRef<ReturnType<typeof window.setTimeout> | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(scrollTimer.current), []);
  const [category, setCategory] = useState<string>(() =>
    TERMINAL_BACKGROUND_CATALOG.find((piece) => piece.id === value)?.category ?? "scenes");
  const search = query.trim().toLowerCase();
  const favoriteIds = new Set(favorites);
  const deletedIds = new Set(deleted);
  const matches = TERMINAL_BACKGROUND_CATALOG.filter((piece) => {
    if (category === "deleted") {
      return deletedIds.has(piece.id);
    }
    if (deletedIds.has(piece.id)) {
      return false;
    }
    return (category === "favorites" ? favoriteIds.has(piece.id) : piece.category === category)
      && `${piece.name} ${piece.id} ${piece.note} ${RUSSIAN_NAMES[piece.id] ?? ""}`.toLowerCase().includes(search);
  });
  return <div className="terminal-background-catalog">
    <div className="terminal-background-toolbar">
      <select className="terminal-background-search" value={category}
        aria-label={locale === "ru" ? "Категория фонов" : "Background category"}
        onChange={(event) => { setCategory(event.currentTarget.value); setQuery(""); setHovered(null); setFocused(null); }}>
        <option value="favorites">{locale === "ru" ? "Избранное" : "Favorites"} · {favorites.length}</option>
        {deleted.length > 0 && (
          <option value="deleted">{locale === "ru" ? "Удалённые" : "Deleted"} · {deleted.length}</option>
        )}
        {CATEGORIES.map(([id, ru, en]) => <option key={id} value={id}>
          {locale === "ru" ? ru : en} · {TERMINAL_BACKGROUND_CATALOG.filter((piece) => piece.category === id && !deletedIds.has(piece.id)).length}
        </option>)}
      </select>
      <input type="search" className="terminal-background-search" value={query}
      aria-label={locale === "ru" ? "Поиск фона" : "Search backgrounds"}
      placeholder={locale === "ru" ? "Поиск в категории" : "Search this category"}
      onChange={(event) => setQuery(event.currentTarget.value)} />
      <div className="terminal-background-actions">
        {category === "deleted" ? (
          <button type="button" className="border-skin-choice terminal-background-disable"
            onClick={() => onDeletedChange?.([])}>
            {locale === "ru" ? "Восстановить все" : "Restore all"}
          </button>
        ) : (
          <button type="button" className="border-skin-choice terminal-background-disable" aria-pressed={value === "none"} onClick={() => onChange("none")}>
            {locale === "ru" ? "Без фона" : "No background"}
          </button>
        )}
        {onDisableAll && category !== "deleted" && (
          <button type="button" className="border-skin-choice terminal-background-disable terminal-background-disable-all"
            aria-label={locale === "ru" ? "Отключить фон на всех терминалах и сбросить индивидуальные настройки" : "Disable background on all terminals and clear overrides"}
            onClick={onDisableAll}>
            {locale === "ru" ? "Отключить всем" : "Disable for all"}
          </button>
        )}
      </div>
    </div>
    <div key={category} className="terminal-background-results" role="region"
      onScroll={() => {
        setScrolling(true);
        window.clearTimeout(scrollTimer.current);
        scrollTimer.current = window.setTimeout(() => setScrolling(false), 150);
      }}
      aria-label={locale === "ru" ? "Фоны выбранной категории" : "Backgrounds in the selected category"} tabIndex={0}>
      <div className="border-skin-choices" role="group" aria-label={locale === "ru" ? "Выбор фона" : "Choose a background"}>
          {matches.map(({ id, name }) => <div key={id} className="terminal-background-tile">
            <button type="button" className="border-skin-choice" aria-pressed={value === id}
            onClick={() => onChange(id)}
            onPointerEnter={() => setHovered(id)} onPointerLeave={() => setHovered(null)}
            onFocus={() => setFocused(id)} onBlur={() => setFocused(null)}>
            <ScenePreview scene={id} animated={!paused && !scrolling && id === (hovered ?? focused)} />
            <span className="border-skin-choice__label">{locale === "ru" ? RUSSIAN_NAMES[id] ?? name : name}</span>
            </button>
            {category === "deleted" ? (
              onDeletedChange && (
                <button type="button" className="terminal-background-restore"
                  aria-label={`${locale === "ru" ? "Восстановить фон" : "Restore background"}: ${locale === "ru" ? RUSSIAN_NAMES[id] ?? name : name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeletedChange(deleted.filter(item => item !== id));
                  }}>
                  <svg viewBox="0 0 24 24" aria-hidden="true" style={{ width: "13px", height: "13px", fill: "none", stroke: "currentColor", strokeWidth: 2.2, strokeLinecap: "round", strokeLinejoin: "round" }}>
                    <polyline points="1 4 1 10 7 10" />
                    <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
                  </svg>
                  {locale === "ru" ? "Вернуть" : "Restore"}
                </button>
              )
            ) : (
              onDeletedChange && (
                <button type="button" className="terminal-background-delete"
                  aria-label={`${locale === "ru" ? "Удалить фон" : "Delete background"}: ${locale === "ru" ? RUSSIAN_NAMES[id] ?? name : name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (window.confirm(locale === "ru" ? `Удалить фон «${RUSSIAN_NAMES[id] ?? name}» из каталога?` : `Delete background "${name}" from catalog?`)) {
                      onDeletedChange([...deleted, id]);
                      if (value === id) onChange("none");
                    }
                  }}>
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6" />
                  </svg>
                </button>
              )
            )}
            <button type="button" className="terminal-background-favorite" aria-pressed={favoriteIds.has(id)}
              aria-label={`${locale === "ru" ? (favoriteIds.has(id) ? "Убрать из избранного" : "Добавить в избранное") : (favoriteIds.has(id) ? "Remove from favorites" : "Add to favorites")}: ${locale === "ru" ? RUSSIAN_NAMES[id] ?? name : name}`}
              onClick={() => onFavoritesChange(favoriteIds.has(id) ? favorites.filter(item => item !== id) : [...favorites, id])}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 2.8 5.7 6.3.9-4.6 4.4 1.1 6.3L12 17.3l-5.6 3 1.1-6.3L2.9 9.6l6.3-.9Z" /></svg>
            </button>
          </div>)}
      </div>
      {!matches.length && <p role="status">{category === "favorites" && !favorites.length
        ? (locale === "ru" ? "В избранном пока пусто. Добавляйте фоны звёздочкой на карточке." : "No favorites yet. Use the star on a card to add a background.")
        : category === "deleted"
        ? (locale === "ru" ? "Корзина пуста. Удалённые фоны будут отображаться здесь." : "Trash is empty. Deleted backgrounds will appear here.")
        : (locale === "ru" ? "Фоны не найдены" : "No backgrounds found")}</p>}
    </div>
  </div>;
}
