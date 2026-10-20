import { describe, it, expect } from 'vitest';
import { displayWidth, truncField, truncatePath, fitSegments, padLine, safeCols } from '../../src/render/text.js';

describe('displayWidth', () => {
  it('measures plain ASCII', () => { expect(displayWidth('hello')).toBe(5); });
  it('strips ANSI codes', () => { expect(displayWidth('\x1b[36mhello\x1b[0m')).toBe(5); });
  it('counts zero-width chars as 0', () => { expect(displayWidth('a\u200Db')).toBe(2); });
  it('counts CJK as 2', () => { expect(displayWidth('\u4E16')).toBe(2); });
  it('counts emoji as 2', () => { expect(displayWidth('\u{1F600}')).toBe(2); });
  it('counts block chars as 1', () => { expect(displayWidth('\u2588\u2591')).toBe(2); });
  // Box Drawing block (U+2500\u2013U+257F) is always single-cell. The vertical bar
  // U+2502 is lumira's default segment separator (SEP), so miscounting it as 2
  // over-reserves width on every line and makes right-anchored content misalign
  // between lines (each line has a different separator count).
  it('counts box-drawing separator \u2502 (U+2502) as 1', () => { expect(displayWidth('\u2502')).toBe(1); });
  it('counts box-drawing chars as 1', () => { expect(displayWidth('\u2500\u2502\u250c\u2510\u2514\u2518')).toBe(6); });
  // Nerd Font BMP-PUA (fa-robot U+F418) and Supplementary PUA-A
  // (nf-md-battery U+F0083) glyphs both render single-cell on patched fonts;
  // width must reflect that or fitSegments over-reserves space.
  it('counts Nerd Font BMP-PUA glyphs as 1', () => { expect(displayWidth('\uf418')).toBe(1); });
  it('counts Nerd Font Supplementary PUA-A glyphs as 1', () => {
    expect(displayWidth('\u{F0083}')).toBe(1); // battery_alert
    expect(displayWidth('\u{F0079}')).toBe(1); // battery (full)
    expect(displayWidth('\u{F008E}')).toBe(1); // battery_outline
  });
  // The symbol blocks (U+2300–24FF, 25A0–25FF, 2600–27BF, 2B00–2BFF) are
  // mostly East Asian Width N/A — terminals draw them in one cell. Counting the
  // whole blocks as two left every line using them short of the edge.
  it('counts the text symbols lumira draws as 1', () => {
    for (const ch of ['✓', '○', '◐', '⚠', '⬆', '▶', '▸', '❯', '❄', '⏱']) expect(displayWidth(ch)).toBe(1);
  });
  it('counts East Asian Wide symbols in those blocks as 2', () => {
    for (const ch of ['✅', '⚡', '⭐', '⌛', '❌', '☕']) expect(displayWidth(ch)).toBe(2);
  });
  it('counts a narrow symbol followed by VS16 (emoji presentation) as 2', () => {
    expect(displayWidth('⚠️')).toBe(2);
    expect(displayWidth('⏱️')).toBe(2);
    expect(displayWidth('❄️')).toBe(2);
  });
  it('does not add a cell for VS16 after a character that is already wide', () => {
    expect(displayWidth('\u{1F3CE}️')).toBe(2);
    expect(displayWidth('⚡️')).toBe(2);
  });
  it('counts a keycap sequence as the two cells terminals draw', () => {
    expect(displayWidth('1️⃣')).toBe(2);
  });
  it('measures mixed text with symbols cell by cell', () => {
    expect(displayWidth('✓ Read ◐ Edit')).toBe(13);
    expect(displayWidth('⚠️ ~2d')).toBe(6);
  });
});

describe('truncField', () => {
  it('returns string unchanged if within limit', () => { expect(truncField('hello', 10)).toBe('hello'); });
  it('truncates with ellipsis', () => { expect(truncField('hello world', 6)).toBe('hello\u2026'); });
  it('handles max=1', () => { expect(truncField('hello', 1)).toBe('\u2026'); });
  it('truncates one-cell symbols by their real width', () => { expect(truncField('\u2713\u2713\u2713\u2713', 3)).toBe('\u2713\u2713\u2026'); });
  it('keeps a VS16 with its base so an emoji pair is never split or undercounted', () => {
    expect(truncField('\u26a0\ufe0f\u26a0\ufe0f\u26a0\ufe0f', 4)).toBe('\u26a0\ufe0f\u2026');
  });
});

describe('truncatePath', () => {
  it('returns short path unchanged', () => { expect(truncatePath('/a/b', 20)).toBe('/a/b'); });
  it('truncates with .../filename', () => { expect(truncatePath('/very/long/path/to/file.ts', 15)).toBe('.../file.ts'); });
  it('returns empty for empty input', () => { expect(truncatePath('', 20)).toBe(''); });
});

describe('fitSegments', () => {
  it('joins left and right when they fit', () => {
    const result = fitSegments(['A', 'B'], ['X', 'Y'], ' | ', 30);
    expect(result).toContain('A');
    expect(result).toContain('Y');
  });
  it('drops right segments when too wide', () => {
    const result = fitSegments(['AAAA'], ['XXXX', 'YYYY', 'ZZZZ'], ' | ', 20);
    expect(result).toContain('AAAA');
  });
  it('returns only left when nothing fits', () => {
    const result = fitSegments(['LEFT'], ['RIGHT'], ' | ', 10);
    expect(result).toContain('LEFT');
  });

  it('drops tail left segment when left alone overflows', () => {
    const model = 'A'.repeat(20);
    const branch = 'B'.repeat(85);
    const dir = 'C'.repeat(25);
    const result = fitSegments([model, branch, dir], [], ' | ', 120);
    expect(displayWidth(result)).toBeLessThanOrEqual(116);
    expect(result).toContain('A'.repeat(20));     // model kept
    expect(result).toContain('B'.repeat(85));     // branch kept
    expect(result).not.toContain('C'.repeat(25)); // dir dropped
  });

  it('last-resort: truncates single oversized segment without ANSI bleed', () => {
    const result = fitSegments(['X'.repeat(200)], [], ' | ', 50);
    expect(displayWidth(result)).toBeLessThanOrEqual(46);
    expect(result).toContain('…'); // ellipsis present
    expect(result.endsWith('…')).toBe(true); // no stray ANSI reset after plain-text truncation
  });

  it('ANSI-colored left that overflows stays within displayWidth bounds', () => {
    const colored = `\x1b[36m${'B'.repeat(90)}\x1b[0m`;
    const result = fitSegments([colored], [], ' | ', 80);
    expect(displayWidth(result)).toBeLessThanOrEqual(76);
  });

  it('leftW === safeCols exactly returns left unchanged', () => {
    const left = 'A'.repeat(16); // safeCols = 20-4 = 16
    const result = fitSegments([left], [], ' | ', 20);
    expect(result).toBe(left);
  });
});

describe('safeCols', () => {
  it('reserves a 4-cell right margin', () => { expect(safeCols(120)).toBe(116); });
  it('never returns below 1', () => { expect(safeCols(2)).toBe(1); });
  it('matches the width fitSegments fits into', () => {
    // fitSegments must not exceed safeCols(cols) for the same cols.
    const result = fitSegments(['X'.repeat(200)], [], ' | ', 50);
    expect(displayWidth(result)).toBeLessThanOrEqual(safeCols(50));
  });
});

describe('padLine', () => {
  it('pads between left and right to fill cols', () => {
    const result = padLine('left', 'right', 20);
    expect(displayWidth(result)).toBe(20);
  });
});

describe('displayWidth — East Asian wide scripts', () => {
  it.each([
    ['Hiragana', 'あいう', 6],
    ['Katakana', 'カタカナ', 8],
    ['Hangul syllables', '한국어', 6],
    ['Hangul Jamo (U+1100)', 'ᄀ', 2],
    ['enclosed CJK (U+3231)', '㈱', 2],
    ['CJK Ext-A (U+3400)', '㐀', 2],
    ['CJK compatibility (U+F900)', '豈', 2],
    ['CJK radicals (U+2E80)', '⺀', 2],
    ['fullwidth yen (U+FFE5)', '￥', 2],
    ['fullwidth A (U+FF21)', 'Ａ', 2],
    ['CJK unified, already wide', '中文', 4],
  ])('counts %s as 2 cells per character', (_label, text, width) => {
    expect(displayWidth(text)).toBe(width);
  });

  it.each([
    ['halfwidth katakana (U+FF71)', 'ｱ', 1],
    ['halfwidth katakana run', 'ｱｲｳ', 3],
    ['halfwidth arrow (U+FFE9)', '￩', 1],
    ['circled number on black square (U+3248, ambiguous)', '㉈', 1],
  ])('counts %s as 1 cell', (_label, text, width) => {
    expect(displayWidth(text)).toBe(width);
  });

  it('truncates Japanese by cells, not code points', () => {
    const out = truncField('あいうえおか', 7);
    expect(displayWidth(out)).toBeLessThanOrEqual(7);
    expect(out).toBe('あいう…');
  });
});

describe('fitSegments — empty left side', () => {
  it('keeps the right-hand segments when there is nothing on the left', () => {
    expect(fitSegments([], ['[NORMAL]', '^high'], ' | ', 80)).toBe('[NORMAL] | ^high');
  });

  it('drops right-hand segments from the end until they fit', () => {
    expect(fitSegments([], ['aaaaaaaaaa', 'bbbbbbbbbb'], ' | ', 20)).toBe('aaaaaaaaaa');
  });
});
