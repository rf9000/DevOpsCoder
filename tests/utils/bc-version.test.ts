import { describe, it, expect } from 'bun:test';
import {
  parseBcVersion,
  compareBcVersions,
  maxBcVersion,
  selectBcVersion,
  satisfiesBcVersion,
} from '../../src/utils/bc-version.ts';

describe('parseBcVersion', () => {
  it('parses a full four-part version', () => {
    expect(parseBcVersion('29.0.0.0')).toEqual([29, 0, 0, 0]);
  });

  it('pads short forms to four segments', () => {
    expect(parseBcVersion('29.0')).toEqual([29, 0, 0, 0]);
    expect(parseBcVersion('29')).toEqual([29, 0, 0, 0]);
  });

  it('returns undefined for anything unparseable', () => {
    expect(parseBcVersion('')).toBeUndefined();
    expect(parseBcVersion('   ')).toBeUndefined();
    expect(parseBcVersion('abc')).toBeUndefined();
    expect(parseBcVersion('29.x.0.0')).toBeUndefined();
    expect(parseBcVersion('1.2.3.4.5')).toBeUndefined();
  });
});

describe('compareBcVersions', () => {
  it('orders numerically, not lexically', () => {
    // "9.0.0.0" > "29.0.0.0" as strings — the bug this module exists to avoid.
    expect(compareBcVersions([9, 0, 0, 0], [29, 0, 0, 0])).toBeLessThan(0);
    expect(compareBcVersions([29, 0, 0, 0], [9, 0, 0, 0])).toBeGreaterThan(0);
  });

  it('returns 0 for equal versions', () => {
    expect(compareBcVersions([29, 0, 0, 0], [29, 0, 0, 0])).toBe(0);
  });

  it('compares later segments when earlier ones tie', () => {
    expect(compareBcVersions([28, 1, 0, 0], [28, 5, 0, 0])).toBeLessThan(0);
  });
});

describe('maxBcVersion', () => {
  it('picks the numerically highest', () => {
    expect(maxBcVersion(['9.0.0.0', '29.0.0.0', '28.1.0.0'])).toBe('29.0.0.0');
  });

  it('ignores unparseable entries', () => {
    expect(maxBcVersion(['not-a-version', '28.1.0.0'])).toBe('28.1.0.0');
  });

  it('returns undefined when nothing is parseable', () => {
    expect(maxBcVersion([])).toBeUndefined();
    expect(maxBcVersion(['junk'])).toBeUndefined();
  });

  it('returns the original string spelling, not the padded form', () => {
    expect(maxBcVersion(['29.0'])).toBe('29.0');
  });
});

describe('selectBcVersion', () => {
  const available = ['16.0.0.0', '28.1.0.0', '28.5.0.0', '29.0.0.0'];

  it('prefers an exact match', () => {
    expect(selectBcVersion('29.0.0.0', available)).toBe('29.0.0.0');
  });

  it('picks the lowest version above the requirement when there is no exact match', () => {
    expect(selectBcVersion('29.0.0.0', ['28.5.0.0', '29.1.0.0', '30.0.0.0'])).toBe('29.1.0.0');
  });

  it('returns undefined when nothing satisfies', () => {
    expect(selectBcVersion('31.0.0.0', available)).toBeUndefined();
  });

  it('ignores unparseable candidates', () => {
    expect(selectBcVersion('29.0.0.0', ['junk', '29.0.0.0'])).toBe('29.0.0.0');
  });

  it('returns undefined when the requirement itself is unparseable', () => {
    expect(selectBcVersion('junk', available)).toBeUndefined();
  });
});

describe('satisfiesBcVersion', () => {
  it('accepts an equal or higher actual version', () => {
    expect(satisfiesBcVersion('29.0.0.0', '29.0.0.0')).toBe(true);
    expect(satisfiesBcVersion('29.0.0.0', '30.0.0.0')).toBe(true);
  });

  it('rejects a lower actual version', () => {
    expect(satisfiesBcVersion('29.0.0.0', '28.1.0.0')).toBe(false);
  });

  it('accepts when either side is unparseable — an impossible comparison never blocks', () => {
    expect(satisfiesBcVersion('29.0.0.0', 'unknown')).toBe(true);
    expect(satisfiesBcVersion('unknown', '28.1.0.0')).toBe(true);
  });
});
