import { describe, it, expect } from 'vitest';
import { semverCompare } from '../../src/utils/semver.js';

describe('semverCompare', () => {
  it.each([
    ['2.1.330', '2.1.323', 1],
    ['2.1.323', '2.1.330', -1],
    ['2.1.323', '2.1.323', 0],
    ['2.2.0', '2.1.99', 1],
    ['3.0.0', '2.99.99', 1],
    ['10.0.0', '9.9.9', 1],
  ])('should_order_%s_against_%s_as_%i', (a, b, expected) => {
    expect(semverCompare(a, b)).toBe(expected);
  });

  it('should_compare_each_part_as_a_number_not_as_text', () => {
    expect(semverCompare('2.1.9', '2.1.10')).toBe(-1);
    expect(semverCompare('1.10.0', '1.9.0')).toBe(1);
  });

  it('should_ignore_a_leading_v', () => {
    expect(semverCompare('v2.1.0', '2.1.0')).toBe(0);
  });

  it('should_treat_missing_parts_as_zero', () => {
    expect(semverCompare('2.1', '2.1.0')).toBe(0);
    expect(semverCompare('2', '2.0.1')).toBe(-1);
  });
});
