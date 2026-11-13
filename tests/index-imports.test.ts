import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('src/index.ts startup cost', () => {
  const src = readFileSync(join(import.meta.dirname, '..', 'src', 'index.ts'), 'utf8');
  const staticSpecifiers = [...src.matchAll(/^(?:import|export)\s[^;]*?\sfrom\s+['"]([^'"]+)['"]/gm)].map(m => m[1]);

  it.each([
    './installer.js',
    './commands/themes.js',
    './commands/stats.js',
    './commands/widget.js',
    './commands/subagent.js',
    './commands/custom-refresh.js',
    './parsers/custom-commands.js',
  ])('loads %s on demand, not on the render path', mod => {
    expect(staticSpecifiers).not.toContain(mod);
    expect(src).toMatch(new RegExp(`import\\(\\s*['"]${mod.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]\\s*\\)`));
  });

  it('still statically imports what the render path needs', () => {
    expect(staticSpecifiers).toContain('./render/index.js');
  });
});
