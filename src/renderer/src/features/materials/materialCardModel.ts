import type {
  CanvasMaterial,
  LocaleId,
  MaterialFailure,
  MaterialKind,
  MaterialRejectionReason,
  MaterialsAddResult
} from "../../../../shared/contracts.ts";

export type MaterialIconName = "image" | "file-text" | "film" | "music" | "file";

export type MaterialCommand = "reveal" | "copy-path" | "relink" | "accept-move";

const KIND_ICONS: Record<MaterialKind, MaterialIconName> = {
  image: "image",
  text: "file-text",
  video: "film",
  audio: "music",
  pdf: "file-text",
  file: "file"
};

export function materialIcon(kind: MaterialKind): MaterialIconName {
  return KIND_ICONS[kind];
}

export function materialFolder(location: string | null): string | null {
  if (!location) return null;
  const separator = Math.max(location.lastIndexOf("/"), location.lastIndexOf("\\"));
  return separator > 0 ? location.slice(0, separator) : location;
}

export function formatBytes(bytes: number | null, locale: LocaleId): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return "";
  const units = locale === "ru" ? ["Б", "КБ", "МБ", "ГБ"] : ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 10 ? 0 : 1;
  return `${value.toFixed(digits).replace(".", locale === "ru" ? "," : ".")} ${units[unit]}`;
}

export type MaterialFailureKey =
  | "materialFailureUnavailable"
  | "materialFailureTooLarge"
  | "materialFailureQuota"
  | "materialFailureUnreadable"
  | "materialFailureNotAFile"
  | "materialFailureKindMismatch"
  | "materialFailureAlreadyOnCanvas";

export function materialFailureKey(reason: MaterialFailure): MaterialFailureKey | null {
  switch (reason) {
    case "unavailable": return "materialFailureUnavailable";
    case "too-large": return "materialFailureTooLarge";
    case "quota": return "materialFailureQuota";
    case "unreadable": return "materialFailureUnreadable";
    case "not-a-file": return "materialFailureNotAFile";
    case "kind-mismatch": return "materialFailureKindMismatch";
    case "already-on-canvas": return "materialFailureAlreadyOnCanvas";
    default: return null;
  }
}

export type MaterialRejectionKey = "materialsNotAFile" | "materialsUnreadable" | "materialsLimit" | "materialsEmptyClipboard";

export function materialRejectionKey(reason: MaterialRejectionReason): MaterialRejectionKey {
  switch (reason) {
    case "not-a-file": return "materialsNotAFile";
    case "limit": return "materialsLimit";
    case "empty-clipboard": return "materialsEmptyClipboard";
    default: return "materialsUnreadable";
  }
}

export function materialRemovalLosesData(material: CanvasMaterial): boolean {
  return material.location === null || material.versions.length > 0;
}

export function addResultNeedsNotice(result: MaterialsAddResult): boolean {
  return result.rejected.length > 0 || (result.added.length === 0 && result.existing.length > 0);
}
