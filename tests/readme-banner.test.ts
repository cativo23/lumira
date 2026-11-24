import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const minor = (version: string): string => {
  const [major, mid] = version.split('.');
  return `${major}.${mid}`;
};

describe('README "What\'s new" banner', () => {
  const banner = /What's new in v(\d+\.\d+\.\d+)/.exec(read('README.md'));
  const pkg = JSON.parse(read('package.json')) as { version: string };

  it('should_exist_near_the_top_of_the_readme', () => {
    expect(banner).not.toBeNull();
    expect(read('README.md').indexOf(banner![0])).toBeLessThan(6000);
  });

  it('should_name_the_current_minor_version_so_a_release_cannot_leave_it_behind', () => {
    expect(minor(banner![1])).toBe(minor(pkg.version));
  });

  it('should_not_name_a_version_newer_than_the_package', () => {
    const [a, b] = [banner![1], pkg.version].map(v => v.split('.').map(Number));
    const newer = a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] > b[2])));
    expect(newer).toBe(false);
  });
});
