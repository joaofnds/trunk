export type DateStyle = "short" | "medium" | "long" | "relative";

export function formatDate(date: Date, style: DateStyle = "short"): string {
  const now = new Date();

  switch (style) {
    case "short":
      return date.toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "2-digit" });
    case "medium":
      return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    case "long":
      return date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", weekday: "long" });
    case "relative":
      return getRelativeTime(date, now);
  }
}

function getRelativeTime(date: Date, now: Date): string {
  const diffMs = now.getTime() - date.getTime();
  const diffMinutes = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMinutes < 1) return "just now";
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return formatDate(date, "medium");
}
