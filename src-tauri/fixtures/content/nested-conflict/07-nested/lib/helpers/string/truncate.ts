export function truncate(str: string, maxLength: number, suffix: string = "..."): string {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - suffix.length) + suffix;
}

export function truncateWords(str: string, maxWords: number, suffix: string = "..."): string {
  const words = str.split(/\s+/);
  if (words.length <= maxWords) return str;
  return words.slice(0, maxWords).join(" ") + suffix;
}

export function ellipsis(str: string, maxLength: number): string {
  return truncate(str, maxLength, "\u2026");
}
