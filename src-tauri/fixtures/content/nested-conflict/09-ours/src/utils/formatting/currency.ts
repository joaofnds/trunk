export type CurrencyCode = "USD" | "EUR" | "GBP" | "JPY" | "BRL" | "INR" | "CNY";

const CURRENCY_CONFIG: Record<CurrencyCode, { symbol: string; decimals: number; locale: string }> = {
  USD: { symbol: "$", decimals: 2, locale: "en-US" },
  EUR: { symbol: "\u20ac", decimals: 2, locale: "de-DE" },
  GBP: { symbol: "\u00a3", decimals: 2, locale: "en-GB" },
  JPY: { symbol: "\u00a5", decimals: 0, locale: "ja-JP" },
  BRL: { symbol: "R$", decimals: 2, locale: "pt-BR" },
  INR: { symbol: "\u20b9", decimals: 2, locale: "en-IN" },
  CNY: { symbol: "\u00a5", decimals: 2, locale: "zh-CN" },
};

export function formatCurrency(amount: number, currency: CurrencyCode): string {
  const config = CURRENCY_CONFIG[currency];
  return new Intl.NumberFormat(config.locale, {
    style: "currency",
    currency: currency,
    minimumFractionDigits: config.decimals,
    maximumFractionDigits: config.decimals,
  }).format(amount);
}

export function parseCurrency(value: string): number | null {
  const cleaned = value.replace(/[^0-9.-]/g, "");
  const parsed = parseFloat(cleaned);
  return isNaN(parsed) ? null : parsed;
}

export function getCurrencySymbol(currency: CurrencyCode): string {
  return CURRENCY_CONFIG[currency].symbol;
}
