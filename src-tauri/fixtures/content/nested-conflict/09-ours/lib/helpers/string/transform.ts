function tokenize(str: string): string[] {
  return str
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_\-]+/g, " ")
    .trim()
    .split(/\s+/)
    .map((s) => s.toLowerCase());
}

export function camelToSnake(str: string): string {
  return tokenize(str).join("_");
}

export function snakeToCamel(str: string): string {
  const words = tokenize(str);
  return words[0] + words.slice(1).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
}

export function kebabToCamel(str: string): string {
  return snakeToCamel(str.replace(/-/g, "_"));
}

export function camelToKebab(str: string): string {
  return tokenize(str).join("-");
}

export function toPascalCase(str: string): string {
  return tokenize(str).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
}

export function titleCase(str: string): string {
  return tokenize(str)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
