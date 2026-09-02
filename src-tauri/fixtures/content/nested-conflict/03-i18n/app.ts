export function greet(name: string, locale: string = "en"): string {
  const greetings: Record<string, string> = {
    en: "Hello",
    es: "Hola",
    fr: "Bonjour",
  };
  return `${greetings[locale] ?? "Hello"}, ${name}!`;
}

export function add(a: number, b: number): number {
  return a + b;
}

export function formatDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
