import { describe, it, expect } from 'vitest';
import { FREE_FEATURES, PRO_FEATURES, PREMIUM_FEATURES } from './index.js';

describe('@workspace/plan-copy feature arrays', () => {
  it('FREE_FEATURES is a non-empty array of strings', () => {
    expect(Array.isArray(FREE_FEATURES)).toBe(true);
    expect(FREE_FEATURES.length).toBeGreaterThan(0);
    FREE_FEATURES.forEach((f) => {
      expect(typeof f).toBe('string');
      expect(f.trim().length).toBeGreaterThan(0);
    });
  });

  it('PRO_FEATURES is a non-empty array of strings', () => {
    expect(Array.isArray(PRO_FEATURES)).toBe(true);
    expect(PRO_FEATURES.length).toBeGreaterThan(0);
    PRO_FEATURES.forEach((f) => {
      expect(typeof f).toBe('string');
      expect(f.trim().length).toBeGreaterThan(0);
    });
  });

  it('PREMIUM_FEATURES is a non-empty array of strings', () => {
    expect(Array.isArray(PREMIUM_FEATURES)).toBe(true);
    expect(PREMIUM_FEATURES.length).toBeGreaterThan(0);
    PREMIUM_FEATURES.forEach((f) => {
      expect(typeof f).toBe('string');
      expect(f.trim().length).toBeGreaterThan(0);
    });
  });
});
