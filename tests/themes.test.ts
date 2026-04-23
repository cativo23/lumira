import { describe, it, expect } from 'vitest';
import { THEMES, getThemeNames, resolveTheme } from '../src/themes.js';

describe('THEMES', () => {
  it('has at least 7 themes', () => {
    expect(Object.keys(THEMES).length).toBeGreaterThanOrEqual(7);
  });

  it('each theme has all required color keys', () => {
    const requiredKeys = ['cyan', 'magenta', 'yellow', 'green', 'orange', 'red', 'brightBlue', 'gray'];
    for (const [, palette] of Object.entries(THEMES)) {
      for (const key of requiredKeys) {
        expect(palette).toHaveProperty(key);
        expect((palette as Record<string, string>)[key]).toContain('\x1b[38;2;');
      }
    }
  });
});

describe('getThemeNames', () => {
  it('returns all theme names', () => {
    const names = getThemeNames();
    expect(names).toEqual(
      expect.arrayContaining(['dracula', 'nord', 'tokyo-night', 'catppuccin', 'monokai', 'gruvbox', 'solarized']),
    );
  });
});

describe('resolveTheme', () => {
  it('returns null when no theme specified', () => {
    expect(resolveTheme(undefined, 'truecolor')).toBeNull();
  });

  it('returns null in named mode (insufficient color fidelity)', () => {
    expect(resolveTheme('dracula', 'named')).toBeNull();
  });

  it('returns a downgraded 256-color palette in 256 mode', () => {
    const palette = resolveTheme('dracula', '256');
    expect(palette).not.toBeNull();
    expect(palette!.cyan).toMatch(/^\x1b\[38;5;\d+m$/);
    expect(palette!.magenta).toMatch(/^\x1b\[38;5;\d+m$/);
  });

  it('returns the raw RGB palette in truecolor mode', () => {
    const palette = resolveTheme('dracula', 'truecolor');
    expect(palette).not.toBeNull();
    expect(palette!.cyan).toContain('\x1b[38;2;');
  });

  it('is case-insensitive', () => {
    expect(resolveTheme('Dracula', 'truecolor')).not.toBeNull();
    expect(resolveTheme('NORD', 'truecolor')).not.toBeNull();
  });

  it('returns null for unknown theme', () => {
    expect(resolveTheme('nonexistent', 'truecolor')).toBeNull();
  });
});
