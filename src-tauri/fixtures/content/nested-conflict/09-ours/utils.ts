// -- String transforms --

export function capitalize(str: string): string {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
}

export function slugify(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

export function padLeft(str: string, length: number, char: string = " "): string {
  while (str.length < length) {
    str = char + str;
  }
  return str;
}

export function repeat(str: string, count: number): string {
  if (count < 0) throw new Error("count must be non-negative");
  return str.repeat(count);
}

// -- Validation helpers --

export function isEmail(str: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str);
}

export function isURL(str: string): boolean {
  try {
    new URL(str);
    return true;
  } catch {
    return false;
  }
}

// -- Number formatting --

export function formatNumber(n: number, decimals: number = 2): string {
  return n.toFixed(decimals);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
