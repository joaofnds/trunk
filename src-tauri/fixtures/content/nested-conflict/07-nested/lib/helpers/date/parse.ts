export function parseDate(input: string): Date | null {
  const date = new Date(input);
  if (isNaN(date.getTime())) return null;
  return date;
}

export function parseDateStrict(input: string, format: "YYYY-MM-DD" | "MM/DD/YYYY"): Date | null {
  if (format === "YYYY-MM-DD") {
    const match = input.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    return new Date(parseInt(match[1]), parseInt(match[2]) - 1, parseInt(match[3]));
  }
  if (format === "MM/DD/YYYY") {
    const match = input.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!match) return null;
    return new Date(parseInt(match[3]), parseInt(match[1]) - 1, parseInt(match[2]));
  }
  return null;
}

export function toISODateString(date: Date): string {
  return date.toISOString().split("T")[0];
}
