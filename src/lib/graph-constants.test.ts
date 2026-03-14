import { describe, it, expect } from 'vitest';
import {
  LANE_WIDTH, ROW_HEIGHT, DOT_RADIUS, EDGE_STROKE, WIP_STROKE, MERGE_STROKE,
  OVERLAY_LANE_WIDTH, OVERLAY_ROW_HEIGHT, OVERLAY_DOT_RADIUS, OVERLAY_EDGE_STROKE, OVERLAY_MERGE_STROKE,
} from './graph-constants.js';

describe('graph-constants', () => {
  describe('existing constants unchanged', () => {
    it('LANE_WIDTH is 12', () => expect(LANE_WIDTH).toBe(12));
    it('ROW_HEIGHT is 26', () => expect(ROW_HEIGHT).toBe(26));
    it('DOT_RADIUS is 6', () => expect(DOT_RADIUS).toBe(6));
    it('EDGE_STROKE is 1', () => expect(EDGE_STROKE).toBe(1));
    it('WIP_STROKE is 1.5', () => expect(WIP_STROKE).toBe(1.5));
    it('MERGE_STROKE is 2', () => expect(MERGE_STROKE).toBe(2));
  });

  describe('overlay constants', () => {
    it('OVERLAY_LANE_WIDTH is 16', () => expect(OVERLAY_LANE_WIDTH).toBe(16));
    it('OVERLAY_ROW_HEIGHT is 26', () => expect(OVERLAY_ROW_HEIGHT).toBe(26));
    it('OVERLAY_DOT_RADIUS is 4', () => expect(OVERLAY_DOT_RADIUS).toBe(4));
    it('OVERLAY_EDGE_STROKE is 1.5', () => expect(OVERLAY_EDGE_STROKE).toBe(1.5));
    it('OVERLAY_MERGE_STROKE is 2', () => expect(OVERLAY_MERGE_STROKE).toBe(2));
  });

  describe('overlay proportions', () => {
    it('overlay dot is smaller relative to lane than original', () => {
      const originalRatio = DOT_RADIUS / LANE_WIDTH;
      const overlayRatio = OVERLAY_DOT_RADIUS / OVERLAY_LANE_WIDTH;
      expect(overlayRatio).toBeLessThan(originalRatio);
    });
  });
});
