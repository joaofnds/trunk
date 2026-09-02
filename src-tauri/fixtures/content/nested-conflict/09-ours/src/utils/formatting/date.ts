export type DateStyle = "short" | "medium" | "long" | "relative" | "iso";

export function formatDate(date: Date, style: DateStyle = "short", timeZone?: string): string {
  const options: Intl.DateTimeFormatOptions = timeZone ? { timeZone } : {};

  switch (style) {
    case "short":
      return date.toLocaleDateString("en-US", { ...options, month: "numeric", day: "numeric", year: "2-digit" });
    case "medium":
      return date.toLocaleDateString("en-US", { ...options, month: "short", day: "numeric", year: "numeric" });
    case "long":
      return date.toLocaleDateString("en-US", { ...options, month: "long", day: "numeric", year: "numeric", weekday: "long" });
    case "relative":
      return getRelativeTime(date, new Date());
    case "iso":
      return date.toISOString();
  }
}

function getRelativeTime(date: Date, now: Date): string {
  const diffMs = now.getTime() - date.getTime();
  const isPast = diffMs > 0;
  const absDiff = Math.abs(diffMs);
  const diffMinutes = Math.floor(absDiff / 60000);
  const diffHours = Math.floor(absDiff / 3600000);
  const diffDays = Math.floor(absDiff / 86400000);

  const label = isPast ? "ago" : "from now";

  if (diffMinutes < 1) return "just now";
  if (diffMinutes < 60) return `${diffMinutes}m ${label}`;
  if (diffHours < 24) return `${diffHours}h ${label}`;
  if (diffDays < 30) return `${diffDays}d ${label}`;
  return formatDate(date, "medium");
}
