import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('src/index.ts startup cost', () => {
  const src = readFileSync(join(import.meta.dirname, '..', 'src', 'index.ts'), 'utf8');
  const staticImports = src.split('\n').filter(l => /^import\s/.test(l));

  it.each([
    './installer.js',
    './commands/themes.js',
    './commands/stats.js',
    './commands/widget.js',
    './commands/subagent.js',
    './commands/custom-refresh.js',
    './parsers/custom-commands.js',
  ])('does not statically import %s on the render path', mod => {
    expect(staticImports.filter(l => l.includes(`'${mod}'`))).toEqual([]);
  });
});
