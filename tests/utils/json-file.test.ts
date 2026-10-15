import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeTarget } from '../../src/utils/json-file.js';

describe('writeTarget', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'lumira-json-file-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('returns a plain or missing path unchanged', () => {
    const plain = join(dir, 'plain.json');
    writeFileSync(plain, '{}');
    expect(writeTarget(plain)).toBe(plain);
    expect(writeTarget(join(dir, 'missing.json'))).toBe(join(dir, 'missing.json'));
  });

  it('follows a relative link', () => {
    writeFileSync(join(dir, 'real.json'), '{}');
    symlinkSync('real.json', join(dir, 'link.json'));
    expect(writeTarget(join(dir, 'link.json'))).toBe(join(realpathSync(dir), 'real.json'));
  });

  it('follows a chain of dangling links to its final target', () => {
    symlinkSync('a.json', join(dir, 'settings.json'));
    symlinkSync('b.json', join(dir, 'a.json'));
    expect(writeTarget(join(dir, 'settings.json'))).toBe(join(realpathSync(dir), 'b.json'));
  });

  it('resolves .. in a dangling chain against the real directory, as the OS does', () => {
    mkdirSync(join(dir, 'home'));
    mkdirSync(join(dir, 'real', 'sub'), { recursive: true });
    symlinkSync('../real/sub', join(dir, 'home', 'linkdir'));
    symlinkSync('linkdir/a.json', join(dir, 'home', 'settings.json'));
    symlinkSync('../b.json', join(dir, 'real', 'sub', 'a.json'));
    expect(writeTarget(join(dir, 'home', 'settings.json'))).toBe(join(realpathSync(dir), 'real', 'b.json'));
  });

  it('resolves .. inside a dangling link target after following a directory link', () => {
    mkdirSync(join(dir, 'home'));
    mkdirSync(join(dir, 'real', 'sub'), { recursive: true });
    symlinkSync('../real/sub', join(dir, 'home', 'linkdir'));
    symlinkSync('linkdir/../b.json', join(dir, 'home', 'settings.json'));
    expect(writeTarget(join(dir, 'home', 'settings.json'))).toBe(join(realpathSync(dir), 'real', 'b.json'));
  });

  it('resolves .. inside an existing link target after following a directory link', () => {
    mkdirSync(join(dir, 'home'));
    mkdirSync(join(dir, 'real', 'sub'), { recursive: true });
    writeFileSync(join(dir, 'real', 'b.json'), '{}');
    symlinkSync('../real/sub', join(dir, 'home', 'linkdir'));
    symlinkSync('linkdir/../b.json', join(dir, 'home', 'settings.json'));
    expect(writeTarget(join(dir, 'home', 'settings.json'))).toBe(join(realpathSync(dir), 'real', 'b.json'));
  });

  it('refuses a symlink loop', () => {
    symlinkSync('y.json', join(dir, 'x.json'));
    symlinkSync('x.json', join(dir, 'y.json'));
    expect(() => writeTarget(join(dir, 'x.json'))).toThrow(/ELOOP/);
  });
});
