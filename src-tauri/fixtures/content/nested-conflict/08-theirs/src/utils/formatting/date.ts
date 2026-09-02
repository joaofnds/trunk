export type DateStyle = "short" | "medium" | "long" | "relative" | "timestamp";

export function formatDate(date: Date, style: DateStyle = "short", locale: string = "en-US"): string {
  const now = new Date();

  switch (style) {
    case "short":
      return date.toLocaleDateString(locale, { month: "numeric", day: "numeric", year: "2-digit" });
    case "medium":
      return date.toLocaleDateString(locale, { month: "short", day: "numeric", year: "numeric" });
    case "long":
      return date.toLocaleDateString(locale, { month: "long", day: "numeric", year: "numeric", weekday: "long" });
    case "relative":
      return getRelativeTime(date, now);
    case "timestamp":
      return `${date.toLocaleDateString(locale)} ${date.toLocaleTimeString(locale)}`;
  }
}

function getRelativeTime(date: Date, now: Date): string {
  const diffMs = now.getTime() - date.getTime();
  const absDiff = Math.abs(diffMs);
  const isFuture = diffMs < 0;
  const suffix = isFuture ? "from now" : "ago";

  const diffSeconds = Math.floor(absDiff / 1000);
  const diffMinutes = Math.floor(absDiff / 60000);
  const diffHours = Math.floor(absDiff / 3600000);
  const diffDays = Math.floor(absDiff / 86400000);
  const diffWeeks = Math.floor(diffDays / 7);

  if (diffSeconds < 30) return "just now";
  if (diffMinutes < 1) return `${diffSeconds}s ${suffix}`;
  if (diffMinutes < 60) return `${diffMinutes}m ${suffix}`;
  if (diffHours < 24) return `${diffHours}h ${suffix}`;
  if (diffDays < 7) return `${diffDays}d ${suffix}`;
  if (diffWeeks < 4) return `${diffWeeks}w ${suffix}`;
  return formatDate(date, "medium");
}
