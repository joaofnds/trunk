type CaseStyle = "camel" | "snake" | "kebab" | "pascal" | "title";

export function convertCase(str: string, from: CaseStyle, to: CaseStyle): string {
  const words = splitByCase(str, from);
  return joinByCase(words, to);
}

function splitByCase(str: string, style: CaseStyle): string[] {
  switch (style) {
    case "camel":
    case "pascal":
      return str.split(/(?=[A-Z])/).map((s) => s.toLowerCase());
    case "snake":
      return str.split("_").map((s) => s.toLowerCase());
    case "kebab":
      return str.split("-").map((s) => s.toLowerCase());
    case "title":
      return str.split(/\s+/).map((s) => s.toLowerCase());
  }
}

function joinByCase(words: string[], style: CaseStyle): string {
  switch (style) {
    case "camel":
      return words[0] + words.slice(1).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
    case "pascal":
      return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
    case "snake":
      return words.join("_");
    case "kebab":
      return words.join("-");
    case "title":
      return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  }
}

export function camelToSnake(str: string): string {
  return convertCase(str, "camel", "snake");
}

export function snakeToCamel(str: string): string {
  return convertCase(str, "snake", "camel");
}

export function kebabToCamel(str: string): string {
  return convertCase(str, "kebab", "camel");
}

export function camelToKebab(str: string): string {
  return convertCase(str, "camel", "kebab");
}

export function titleCase(str: string): string {
  return str
    .split(/[\s_-]+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}
