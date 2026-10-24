import type { LocaleId } from "../../../../shared/contracts";

/**
 * Text for changing an installed plugin's source repository. It is shown only inside Settings, so it lives in the
 * Settings chunk instead of the eager translation table.
 */
const en = {
  source: "Source",
  change: "Change source…",
  switchBack: "Switch back to",
  urlLabel: "GitHub repository of the same plugin",
  inspect: "Review",
  reviewTitle: "Switch the source of this plugin",
  from: "Now",
  to: "New",
  otherOwner: "Another owner: this is a different publisher.",
  noChanges: "Permissions, services, hooks and surfaces stay the same.",
  added: "added",
  removed: "removed",
  permissions: "Permissions",
  services: "Native services",
  hooks: "Agent hooks",
  contributions: "Surfaces",
  decide: "Decides on agent tool calls",
  launchPolicy: "Launch policy",
  uses: "Reads data from other extensions",
  shares: "Shares data with other extensions",
  keeps: "Kept: this plugin's stored data, its data folder, its saved keys and the folders you gave it. The new source's code will be able to read all of them.",
  revokes: "Revoked: native code trust, agent hooks and every confirmation that depends on them (agent actions, orchestrators, shared reads — including other extensions' approvals to read from this one). You review and allow them again for the new code.",
  confirm: "Switch source",
  cancel: "Cancel",
  failed: "The source could not be changed. The plugin stays as it was."
};

const ru: Record<keyof typeof en, string> = {
  source: "Источник",
  change: "Сменить источник…",
  switchBack: "Вернуть источник",
  urlLabel: "GitHub-репозиторий того же расширения",
  inspect: "Проверить",
  reviewTitle: "Смена источника расширения",
  from: "Сейчас",
  to: "Новый",
  otherOwner: "Другой владелец: это другой издатель.",
  noChanges: "Разрешения, сервисы, хуки и поверхности не меняются.",
  added: "добавлено",
  removed: "убрано",
  permissions: "Разрешения",
  services: "Нативные сервисы",
  hooks: "Хуки агентов",
  contributions: "Поверхности",
  decide: "Решает по вызовам инструментов агентов",
  launchPolicy: "Политика запуска",
  uses: "Читает данные других расширений",
  shares: "Делится данными с другими расширениями",
  keeps: "Сохраняются: данные расширения, его папка данных, сохранённые ключи и выданные ему папки. Код нового источника сможет прочитать всё это.",
  revokes: "Снимаются: доверие нативному коду, хуки агентов и все подтверждения, которые от них зависят (действия агентов, оркестраторы, чтение данных — и разрешения других расширений читать у этого). Для нового кода вы проверяете и разрешаете их заново.",
  confirm: "Сменить источник",
  cancel: "Отмена",
  failed: "Источник не удалось сменить. Расширение осталось как было."
};

const zhCN: Record<keyof typeof en, string> = {
  source: "来源",
  change: "更换来源…",
  switchBack: "切换回",
  urlLabel: "同一插件的 GitHub 仓库",
  inspect: "检查",
  reviewTitle: "更换此插件的来源",
  from: "当前",
  to: "新的",
  otherOwner: "不同的所有者：这是另一个发布者。",
  noChanges: "权限、服务、钩子和界面保持不变。",
  added: "新增",
  removed: "移除",
  permissions: "权限",
  services: "原生服务",
  hooks: "智能体钩子",
  contributions: "界面",
  decide: "决定智能体的工具调用",
  launchPolicy: "启动策略",
  uses: "读取其他扩展的数据",
  shares: "与其他扩展共享数据",
  keeps: "保留：此插件存储的数据、数据文件夹、已保存的密钥以及你授予它的文件夹。新来源的代码将能读取这些内容。",
  revokes: "撤销：原生代码信任、智能体钩子以及依赖它们的所有确认（智能体操作、编排器、共享读取——包括其他扩展读取此扩展的授权）。你需要为新代码重新检查并允许。",
  confirm: "更换来源",
  cancel: "取消",
  failed: "无法更换来源。插件保持原样。"
};

export type SourceChangeTextKey = keyof typeof en;

export function sourceChangeText(locale: LocaleId, key: SourceChangeTextKey): string {
  const id: string = locale;
  return (id === "ru" ? ru : id === "zh-CN" ? zhCN : en)[key];
}

/** "owner/repository" of a canonical GitHub source URL, for display. */
export function repositoryLabel(sourceUrl: string): string {
  return sourceUrl.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
}
