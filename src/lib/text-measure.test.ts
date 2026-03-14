import { describe, it, expect, beforeEach } from 'vitest';
import { measureTextWidth, truncateWithEllipsis, resetCache } from './text-measure.js';

/** Mock measure function: each char = 7px width */
const mockMeasure = (text: string, _font: string): number => text.length * 7;

describe('measureTextWidth', () => {
  beforeEach(() => {
    resetCache();
  });

  it('returns consistent positive number', () => {
    const width = measureTextWidth('hello', 'test-font', mockMeasure);
    expect(width).toBeGreaterThan(0);
    expect(width).toBe(5 * 7);
  });

  it('caches results (same input returns same value)', () => {
    let callCount = 0;
    const countingMeasure = (text: string, _font: string): number => {
      callCount++;
      return text.length * 7;
    };

    const first = measureTextWidth('hello', 'test-font', countingMeasure);
    const second = measureTextWidth('hello', 'test-font', countingMeasure);
    expect(first).toBe(second);
    expect(callCount).toBe(1);
  });
});

describe('truncateWithEllipsis', () => {
  it('returns full text when it fits within maxWidth', () => {
    const result = truncateWithEllipsis('hi', 100, 'test-font', mockMeasure);
    expect(result.text).toBe('hi');
    expect(result.width).toBe(14);
  });

  it('returns truncated text + "…" when text exceeds maxWidth', () => {
    // "abcdef" = 42px, maxWidth = 30px
    // "abc…" = 4 chars * 7 = 28px fits
    const result = truncateWithEllipsis('abcdef', 30, 'test-font', mockMeasure);
    expect(result.text).toContain('…');
    expect(result.width).toBeLessThanOrEqual(30);
  });

  it('returns just "…" when even single char exceeds maxWidth', () => {
    // Single char + ellipsis = 14px, maxWidth = 5px
    const result = truncateWithEllipsis('abcdef', 5, 'test-font', mockMeasure);
    expect(result.text).toBe('…');
  });

  it('handles empty string', () => {
    const result = truncateWithEllipsis('', 100, 'test-font', mockMeasure);
    expect(result.text).toBe('');
    expect(result.width).toBe(0);
  });
});
