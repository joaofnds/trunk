import { capitalize, padLeft } from "./utils";

// -- Greeting --

type GreetingStyle = "formal" | "casual" | "silent";

const FORMAL_TITLES: Record<string, string> = {
  en: "Dear",
  es: "Estimado/a",
  fr: "Cher/Chère",
  de: "Sehr geehrte/r",
};

export function greet(
  name: string,
  locale: string = "en",
  style: GreetingStyle = "casual",
): string {
  if (style === "silent") return "";

  const displayName = capitalize(name);

  if (style === "formal") {
    const title = FORMAL_TITLES[locale] ?? "Dear";
    return `${title} ${displayName},`;
  }

  const greetings: Record<string, string> = {
    en: "Hey",
    es: "Hola",
    fr: "Salut",
    de: "Hallo",
    ja: "こんにちは",
    pt: "Olá",
  };
  return `${greetings[locale] ?? "Hey"}, ${displayName}!`;
}

// -- Math utilities --

interface MathResult {
  value: number;
  operation: string;
  operands: number[];
}

export function add(a: number, b: number): MathResult {
  return { value: a + b, operation: "add", operands: [a, b] };
}

export function divide(a: number, b: number): MathResult {
  if (b === 0) throw new Error("Division by zero");
  return { value: a / b, operation: "divide", operands: [a, b] };
}

export function modulo(a: number, b: number): MathResult {
  if (b === 0) throw new Error("Modulo by zero");
  return { value: a % b, operation: "modulo", operands: [a, b] };
}

// -- Date formatting --

type DateFormat = "iso" | "us" | "eu" | "compact";

export function formatDate(date: Date, format: DateFormat = "iso"): string {
  const y = date.getFullYear();
  const m = padLeft(String(date.getMonth() + 1), 2, "0");
  const d = padLeft(String(date.getDate()), 2, "0");

  switch (format) {
    case "iso":
      return `${y}-${m}-${d}`;
    case "us":
      return `${m}/${d}/${y}`;
    case "eu":
      return `${d}.${m}.${y}`;
    case "compact":
      return `${y}${m}${d}`;
  }
}

// -- Display helpers --

export function formatUserCard(name: string, email: string, joinDate: Date): string {
  const greeting = greet(name, "en", "formal");
  const joined = formatDate(joinDate, "us");
  return [greeting, `Contact: ${email}`, `Member since: ${joined}`].join("\n");
}
