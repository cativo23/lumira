import { stripAnsi } from './colors.js';

// East Asian Wide (W) code points inside the symbol blocks U+2300–24FF,
// 25A0–25FF, 2600–27BF and 2B00–2BFF (Unicode 16). Everything else in those
// blocks is N or A and terminals draw it in one cell — ✓ ○ ◐ ⚠ ▶ ❯ ❄ included.
const WIDE_SYMBOLS: ReadonlyArray<readonly [number, number]> = [
  [0x231A, 0x231B], [0x2329, 0x232A], [0x23E9, 0x23EC], [0x23F0, 0x23F0], [0x23F3, 0x23F3],
  [0x25FD, 0x25FE],
  [0x2614, 0x2615], [0x2630, 0x2637], [0x2648, 0x2653], [0x267F, 0x267F], [0x268A, 0x268F],
  [0x2693, 0x2693], [0x26A1, 0x26A1], [0x26AA, 0x26AB], [0x26BD, 0x26BE], [0x26C4, 0x26C5],
  [0x26CE, 0x26CE], [0x26D4, 0x26D4], [0x26EA, 0x26EA], [0x26F2, 0x26F3], [0x26F5, 0x26F5],
  [0x26FA, 0x26FA], [0x26FD, 0x26FD], [0x2705, 0x2705], [0x270A, 0x270B], [0x2728, 0x2728],
  [0x274C, 0x274C], [0x274E, 0x274E], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797],
  [0x27B0, 0x27B0], [0x27BF, 0x27BF],
  [0x2B1B, 0x2B1C], [0x2B50, 0x2B50], [0x2B55, 0x2B55],
];

const VS16 = 0xFE0F;

function isWideSymbol(cp: number): boolean {
  for (const [lo, hi] of WIDE_SYMBOLS) if (cp >= lo && cp <= hi) return true;
  return false;
}

function charWidth(cp: number): number {
  if ((cp >= 0xFE00 && cp <= 0xFE0F) || cp === 0x200D || (cp >= 0x0300 && cp <= 0x036F)) return 0;
  // Nerd Font Supplementary Private Use Area-A glyphs (Material Design,
  // codicons, etc., U+F0000–U+FFFFF) render as single cells on patched
  // fonts — same as the BMP PUA Nerd glyphs that fall through to width 1
  // below. Without this exclusion the catch-all `>= 0x1F000` would treat
  // them as 2 cells and break `fitSegments` layout calculations.
  if (cp >= 0xF0000 && cp <= 0xFFFFF) return 1;
  // Kept at 2 even for the few text-default pictographs (🏎 without VS16):
  // over-counting leaves a blank cell, under-counting overflows the line.
  if (cp >= 0x1F000 || (cp >= 0x4E00 && cp <= 0x9FFF) || (cp >= 0x3000 && cp <= 0x303F) ||
      (cp >= 0xFF00 && cp <= 0xFFEF)) return 2;
  return isWideSymbol(cp) ? 2 : 1;
}

export function displayWidth(str: string): number {
  const clean = stripAnsi(str);
  let w = 0;
  let last = 0;
  for (const ch of clean) {
    const cp = ch.codePointAt(0)!;
    // VS16 asks for emoji presentation, which terminals draw two cells wide.
    if (cp === VS16) {
      if (last === 1) { w += 1; last = 2; }
      continue;
    }
    const cw = charWidth(cp);
    w += cw;
    if (cw) last = cw;
  }
  return w;
}

export function truncField(str: string, max: number): string {
  if (displayWidth(str) <= max) return str;
  // Build truncated string unit by unit using display width; a VS16 stays with
  // its base so the pair is measured (and kept or dropped) together.
  const units: string[] = [];
  for (const ch of str) {
    if (ch.codePointAt(0) === VS16 && units.length) units[units.length - 1] += ch;
    else units.push(ch);
  }
  let result = '';
  let w = 0;
  for (const unit of units) {
    const cw = displayWidth(unit);
    if (w + cw + 1 > max) break; // +1 for ellipsis
    result += unit;
    w += cw;
  }
  return result + '…';
}

export function truncatePath(str: string, maxLen: number = 20): string {
  if (!str) return '';
  const normalized = str.replace(/\\/g, '/');
  if (normalized.length <= maxLen) return normalized;
  const parts = normalized.split('/');
  const filename = parts.pop() || normalized;
  if (filename.length >= maxLen) return filename.slice(0, maxLen - 3) + '...';
  return '.../' + filename;
}

// The usable width for a status line: total cols minus a 4-cell right margin.
// The margin absorbs terminals that reserve a trailing cell and prevents the
// off-by-one wraps that motivated it. Kept as the single source of this
// constant so callers computing leftover/fill width can't drift out of sync
// with fitSegments' own bound.
export function safeCols(cols: number): number {
  return Math.max(1, cols - 4);
}

export function fitSegments(left: string[], right: string[], sep: string, cols: number): string {
  const safe = safeCols(cols);

  for (let l = left.length; l >= 1; l--) {
    const lSlice = left.slice(0, l);
    const leftStr = lSlice.join(sep);
    const leftW = displayWidth(leftStr);

    if (leftW > safe) continue;

    for (let r = right.length; r >= 0; r--) {
      const rSlice = right.slice(0, r);
      if (rSlice.length === 0) return leftStr;
      const rightStr = rSlice.join(sep);
      const rightW = displayWidth(rightStr);
      if (leftW + 1 + rightW <= safe) {
        const gap = Math.max(1, safe - leftW - rightW);
        return leftStr + ' '.repeat(gap) + rightStr;
      }
    }
  }

  // Last resort: even the first left segment alone exceeds safeCols.
  // Safe because left[0] is the model name (~20 chars) — callers must ensure
  // the first segment is short enough to truncate gracefully.
  // Strip ANSI before hard-truncating to avoid cutting mid-escape-sequence.
  return truncField(stripAnsi(left[0] ?? ''), safe);
}

export function padLine(left: string, right: string, cols: number): string {
  const leftW = displayWidth(left);
  const rightW = displayWidth(right);
  const gap = Math.max(1, cols - leftW - rightW);
  return left + ' '.repeat(gap) + right;
}
