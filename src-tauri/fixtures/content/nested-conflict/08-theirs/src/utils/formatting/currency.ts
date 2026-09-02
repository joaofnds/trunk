export type CurrencyCode = "USD" | "EUR" | "GBP" | "JPY" | "BRL" | "CAD" | "AUD" | "CHF";

interface CurrencyInfo {
  symbol: string;
  decimals: number;
  symbolPosition: "before" | "after";
}

const CURRENCIES: Record<CurrencyCode, CurrencyInfo> = {
  USD: { symbol: "$", decimals: 2, symbolPosition: "before" },
  EUR: { symbol: "\u20ac", decimals: 2, symbolPosition: "after" },
  GBP: { symbol: "\u00a3", decimals: 2, symbolPosition: "before" },
  JPY: { symbol: "\u00a5", decimals: 0, symbolPosition: "before" },
  BRL: { symbol: "R$", decimals: 2, symbolPosition: "before" },
  CAD: { symbol: "CA$", decimals: 2, symbolPosition: "before" },
  AUD: { symbol: "A$", decimals: 2, symbolPosition: "before" },
  CHF: { symbol: "CHF", decimals: 2, symbolPosition: "before" },
};

export function formatCurrency(amount: number, currency: CurrencyCode, locale?: string): string {
  const info = CURRENCIES[currency];
  const formatted = Math.abs(amount).toFixed(info.decimals);
  const sign = amount < 0 ? "-" : "";

  if (info.symbolPosition === "after") {
    return `${sign}${formatted} ${info.symbol}`;
  }
  return `${sign}${info.symbol}${formatted}`;
}

export function parseCurrency(value: string): number | null {
  const cleaned = value.replace(/[^0-9.-]/g, "");
  const parsed = parseFloat(cleaned);
  return isNaN(parsed) ? null : parsed;
}

export function convertCurrency(amount: number, rate: number): number {
  return Math.round(amount * rate * 100) / 100;
}
