type MeasureFn = (text: string, font: string) => number;

let _ctx: OffscreenCanvasRenderingContext2D | null = null;
const _cache = new Map<string, number>();

/**
 * Measures the pixel width of text using Canvas 2D measureText.
 * Results are cached per (text, font) combination.
 *
 * Accepts an optional `rawMeasureFn` for testability — when provided,
 * the Canvas context is bypassed entirely.
 */
export function measureTextWidth(
  text: string,
  font: string,
  rawMeasureFn?: MeasureFn,
): number {
  const key = `${font}::${text}`;
  const cached = _cache.get(key);
  if (cached !== undefined) return cached;

  let width: number;
  if (rawMeasureFn) {
    width = rawMeasureFn(text, font);
  } else {
    if (!_ctx) {
      const canvas = new OffscreenCanvas(0, 0);
      _ctx = canvas.getContext('2d')!;
    }
    _ctx.font = font;
    width = _ctx.measureText(text).width;
  }

  _cache.set(key, width);
  return width;
}

/**
 * Truncates text with ellipsis ("…") to fit within maxWidth.
 * Returns the (possibly truncated) text and its measured width.
 *
 * - If text fits: returns { text, width }
 * - If text too long: progressively trims and appends "…" (U+2026)
 * - If even "…" alone exceeds: returns { text: "…", width: ellipsisWidth }
 * - If empty string: returns { text: "", width: 0 }
 */
export function truncateWithEllipsis(
  text: string,
  maxWidth: number,
  font: string,
  rawMeasureFn?: MeasureFn,
): { text: string; width: number } {
  if (text === '') return { text: '', width: 0 };

  const measure = (t: string) => measureTextWidth(t, font, rawMeasureFn);
  const fullWidth = measure(text);
  if (fullWidth <= maxWidth) return { text, width: fullWidth };

  const ellipsis = '…';

  // Try progressively shorter substrings + ellipsis
  for (let i = text.length - 1; i >= 1; i--) {
    const candidate = text.slice(0, i) + ellipsis;
    const w = measure(candidate);
    if (w <= maxWidth) return { text: candidate, width: w };
  }

  // Even single char + ellipsis doesn't fit — return just ellipsis
  const ellipsisWidth = measure(ellipsis);
  return { text: ellipsis, width: ellipsisWidth };
}

/** Clears the measurement cache. Useful for testing. */
export function resetCache(): void {
  _cache.clear();
  _ctx = null;
}
