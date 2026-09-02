export function greet(name: string): string {
  return `Super Hello, ${name}!`;
}

export function add(a: number, b: number): number {
  return a + b;
}

export function formatDate(date: Date): string {
  return date.toISOString();
}
