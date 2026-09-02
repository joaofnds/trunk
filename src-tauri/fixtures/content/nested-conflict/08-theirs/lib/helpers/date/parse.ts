export type DateFormat = "YYYY-MM-DD" | "MM/DD/YYYY" | "DD/MM/YYYY" | "DD.MM.YYYY";

export function parseDate(input: string): Date | null {
  // Try multiple formats
  for (const fmt of ["YYYY-MM-DD", "MM/DD/YYYY", "DD/MM/YYYY", "DD.MM.YYYY"] as DateFormat[]) {
    const result = parseDateStrict(input, fmt);
    if (result) return result;
  }
  // Fallback to native parsing
  const date = new Date(input);
  if (isNaN(date.getTime())) return null;
  return date;
}

export function parseDateStrict(input: string, format: DateFormat): Date | null {
  switch (format) {
    case "YYYY-MM-DD": {
      const match = input.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (!match) return null;
      return new Date(parseInt(match[1]), parseInt(match[2]) - 1, parseInt(match[3]));
    }
    case "MM/DD/YYYY": {
      const match = input.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
      if (!match) return null;
      return new Date(parseInt(match[3]), parseInt(match[1]) - 1, parseInt(match[2]));
    }
    case "DD/MM/YYYY": {
      const match = input.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
      if (!match) return null;
      return new Date(parseInt(match[3]), parseInt(match[2]) - 1, parseInt(match[1]));
    }
    case "DD.MM.YYYY": {
      const match = input.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
      if (!match) return null;
      return new Date(parseInt(match[3]), parseInt(match[2]) - 1, parseInt(match[1]));
    }
  }
}

export function toISODateString(date: Date): string {
  return date.toISOString().split("T")[0];
}

export function toISODateTime(date: Date): string {
  return date.toISOString();
}
