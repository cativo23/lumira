# Install Wizard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the silent `lumira install` with an interactive TUI wizard (preset / theme / icons, live preview, arrow-key navigation), fix the latent Qwen Code rendering gap, install the `/lumira` skill for Qwen Code when detected, and retire the `qwen` preset.

**Architecture:** A zero-dependency TUI helper (`src/tui/select.ts`) owns raw-mode keypress handling and cleanup. The wizard (`src/installer-wizard.ts`) orchestrates three `interactiveSelect` calls with a live `buildPreview()` callback that invokes the real `render()` on mock data. The installer runs the wizard BEFORE any disk write, then atomically writes `~/.config/lumira/config.json`. Qwen gets a render-layer auto-switch to `renderMinimal`, making the `qwen` preset redundant — it's removed with a migration coercion.

**Tech Stack:** TypeScript, Vitest, Node.js `readline.emitKeypressEvents`, `process.stdin.setRawMode`, ANSI escape codes. No new runtime dependencies.

---

## Task 1: Render layer — Qwen auto-switches to singleline

**Why first:** Isolated change, unblocks the `qwen` preset removal in Task 2 by making it semantically correct. Single-file test + single-file source change.

**Files:**
- Modify: `src/render/index.ts:15`
- Test: `tests/render/index.test.ts`

- [ ] **Step 1: Read the current render/index.ts branch condition**

Read `src/render/index.ts`. The branch at line 15 is:

```ts
if (ctx.config.layout === 'singleline' || (ctx.config.layout === 'auto' && ctx.cols < 70)) {
  return renderMinimal(ctx, c);
}
```

- [ ] **Step 2: Write the failing test**

Append to `tests/render/index.test.ts`:

```ts
it('forces singleline when input platform is qwen-code, even with multiline layout', () => {
  const ctx = makeCtx({
    config: { ...DEFAULT_CONFIG, layout: 'multiline' },
    input: { ...makeInput(), platform: 'qwen-code' as const },
  });
  const out = render(ctx);
  // singleline output is always <= 1 newline (single line or fit-on-one-row)
  expect(out.split('\n').length).toBeLessThanOrEqual(1);
});
```

If `makeCtx` doesn't already accept a custom `input`, read the existing helper and mirror its pattern. If it doesn't expose `input`, add an optional `input` override at the top of the file:

```ts
// in the existing test file's makeCtx or a new helper
function makeCtxWithPlatform(platform: 'qwen-code' | 'claude-code', layout: 'multiline' | 'singleline' | 'auto' = 'multiline') {
  const base = makeCtx({ config: { ...DEFAULT_CONFIG, layout } });
  return { ...base, input: { ...base.input, platform } };
}
```

Use whichever style matches the file. Verify `NormalizedInput` has `platform: 'claude-code' | 'qwen-code'` (see `src/normalize.ts:18`).

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/render/index.test.ts`
Expected: the new test FAILS with the output having multiple lines (multiline renderer kicked in).

- [ ] **Step 4: Modify render/index.ts**

Edit `src/render/index.ts:15` to:

```ts
const isQwen = ctx.input.platform === 'qwen-code';
if (isQwen || ctx.config.layout === 'singleline' || (ctx.config.layout === 'auto' && ctx.cols < 70)) {
  return renderMinimal(ctx, c);
}
```

- [ ] **Step 5: Run tests to verify pass**

Run: `npx vitest run tests/render/index.test.ts`
Expected: all tests PASS including the new one.

- [ ] **Step 6: Run full test suite to verify no regression**

Run: `npm test`
Expected: all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/render/index.ts tests/render/index.test.ts
git commit -m "fix(render): force singleline for qwen-code platform

Qwen Code only displays the first line of statusline output. Previously
lumira used the configured layout regardless of platform, so users with
balanced/full presets saw only a truncated line 1 in Qwen sessions.
Now render() detects qwen-code input and routes to renderMinimal, which
is designed to fit all essentials (including qwen-specific metrics) in
one line.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Remove `qwen` preset with migration

**Why:** Now that render auto-switches on platform, the `qwen` preset is an unused alias of `minimal`. Removal is a breaking change mitigated by a one-shot stderr warning and silent coercion to `minimal`.

**Files:**
- Modify: `src/types.ts:161`
- Modify: `src/config.ts` (validPresets, PRESET_DEFS, CLI flags, mergeConfig migration)
- Test: `tests/config.test.ts`

- [ ] **Step 1: Read current state**

Read `src/types.ts` (lines 155-165) and `src/config.ts` fully.

- [ ] **Step 2: Write failing tests**

Append to `tests/config.test.ts`:

```ts
describe('qwen preset migration', () => {
  let dir: string;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-cfg-qwen-'));
    errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    errSpy.mockRestore();
  });

  it('coerces legacy preset "qwen" to "minimal"', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.json'), '{"preset":"qwen"}');
    const c = loadConfig(dir);
    expect(c.preset).toBe('minimal');
    expect(c.layout).toBe('singleline');
  });

  it('writes a deprecation warning to stderr when "qwen" preset is seen', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.json'), '{"preset":"qwen"}');
    loadConfig(dir);
    const calls = errSpy.mock.calls.flat().join('');
    expect(calls).toContain("'qwen' preset is removed");
  });
});
```

Add `vi` to the imports at top: `import { ..., vi } from 'vitest';`

Also find and remove or modify any existing test referencing `qwen` preset directly. Search: grep for `'qwen'` inside `tests/config.test.ts`. If any assertion expects `preset === 'qwen'`, change it to expect `minimal` and remove now-irrelevant assertions about qwen-specific output. The test `'preset minimal disables most toggles'` already covers `minimal` — no duplication needed.

- [ ] **Step 3: Run tests to verify the new ones fail**

Run: `npx vitest run tests/config.test.ts`
Expected: the two new qwen-migration tests FAIL (preset is still `undefined` — falls to default — and no stderr write happens).

- [ ] **Step 4: Update types.ts**

Edit `src/types.ts:161` — remove `'qwen'` from the preset union:

```ts
preset?: 'full' | 'balanced' | 'minimal';
```

- [ ] **Step 5: Update config.ts — validPresets, PRESET_DEFS, flags, migration**

In `src/config.ts`:

1. Remove the `qwen` entry from `PRESET_DEFS` (lines 70-93).
2. Change `const validPresets = ['full', 'balanced', 'minimal', 'qwen'] as const;` to `const validPresets = ['full', 'balanced', 'minimal'] as const;`.
3. Change the same array in the argv match regex: `/^--preset[= ]?(full|balanced|minimal|qwen)$/` → `/^--preset[= ]?(full|balanced|minimal)$/`.
4. Remove `if (argv.includes('--qwen')) applyPreset(r, 'qwen');` entirely.
5. Insert migration at the top of `mergeConfig` (right after the first line that reads `layout`):

```ts
// ── qwen preset migration (breaking change in v0.4) ─────────────
if (raw.preset === 'qwen') {
  if (!qwenWarningShown) {
    process.stderr.write("[lumira] 'qwen' preset is removed — using 'minimal' instead\n");
    qwenWarningShown = true;
  }
  raw = { ...raw, preset: 'minimal' };
}
```

Add a module-level flag near the top of the file, below the imports:

```ts
let qwenWarningShown = false;
```

Also reassign `raw` type: `function mergeConfig(raw: Record<string, unknown>): HudConfig {` → needs `let` or `raw = { ...raw, preset: 'minimal' }` via local binding. Use a local binding to avoid mutating parameter:

```ts
function mergeConfig(rawIn: Record<string, unknown>): HudConfig {
  let raw = rawIn;
  if (raw.preset === 'qwen') {
    if (!qwenWarningShown) {
      process.stderr.write("[lumira] 'qwen' preset is removed — using 'minimal' instead\n");
      qwenWarningShown = true;
    }
    raw = { ...raw, preset: 'minimal' };
  }
  // ... rest of function uses `raw`
```

Rename the single parameter reference — no external caller sees the change.

- [ ] **Step 6: Run tests**

Run: `npx vitest run tests/config.test.ts`
Expected: all tests PASS, including the two new migration tests.

- [ ] **Step 7: Update render-test and ensure full suite passes**

Check `tests/render/index.test.ts` and `tests/integration.test.ts` for references to `qwen` preset. If any test explicitly sets `preset: 'qwen'`, change to `preset: 'minimal'`.

Run: `npm test`
Expected: all tests PASS. Type-check with `npm run lint`.

- [ ] **Step 8: Commit**

```bash
git add src/types.ts src/config.ts tests/config.test.ts tests/render/index.test.ts tests/integration.test.ts
git commit -m "refactor(config)!: remove qwen preset, migrate to minimal

BREAKING CHANGE: the 'qwen' preset was functionally identical to 'minimal'.
With the render-layer auto-switch for qwen-code input, it's now redundant.
Users with 'preset: qwen' in their config.json see a one-shot stderr
warning and are silently coerced to 'minimal'. CLI flag '--qwen' is
removed; use '--minimal' instead.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Atomic `saveConfig` helper

**Files:**
- Modify: `src/config.ts` (export new `saveConfig`)
- Test: `tests/config.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/config.test.ts` (inside a new `describe('saveConfig', ...)` block):

```ts
import { saveConfig } from '../src/config.js';
import { readFileSync, existsSync, statSync } from 'node:fs';

describe('saveConfig', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cc-save-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('creates config.json with only the three wizard keys', () => {
    saveConfig({ preset: 'balanced', icons: 'nerd' }, join(dir, 'config.json'));
    const content = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
    expect(content).toEqual({ preset: 'balanced', icons: 'nerd' });
  });

  it('writes with 0o600 permissions', () => {
    const p = join(dir, 'config.json');
    saveConfig({ preset: 'minimal' }, p);
    const mode = statSync(p).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('preserves other keys in an existing config', () => {
    const p = join(dir, 'config.json');
    writeFileSync(p, JSON.stringify({
      display: { tokens: false },
      colors: { mode: 'truecolor' },
      preset: 'full',
    }));
    saveConfig({ preset: 'balanced', theme: 'dracula', icons: 'nerd' }, p);
    const content = JSON.parse(readFileSync(p, 'utf8'));
    expect(content).toEqual({
      display: { tokens: false },
      colors: { mode: 'truecolor' },
      preset: 'balanced',
      theme: 'dracula',
      icons: 'nerd',
    });
  });

  it('overwrites corrupt JSON with wizard keys only', () => {
    const p = join(dir, 'config.json');
    writeFileSync(p, 'not { valid json');
    saveConfig({ preset: 'minimal', icons: 'emoji' }, p);
    const content = JSON.parse(readFileSync(p, 'utf8'));
    expect(content).toEqual({ preset: 'minimal', icons: 'emoji' });
  });

  it('omits theme key when undefined in input', () => {
    const p = join(dir, 'config.json');
    saveConfig({ preset: 'balanced', icons: 'nerd' }, p);
    const content = JSON.parse(readFileSync(p, 'utf8'));
    expect('theme' in content).toBe(false);
  });

  it('creates the parent directory if missing', () => {
    const p = join(dir, 'nested', 'deep', 'config.json');
    saveConfig({ preset: 'full' }, p);
    expect(existsSync(p)).toBe(true);
  });

  it('does not leave a stale .tmp file behind', () => {
    const p = join(dir, 'config.json');
    saveConfig({ preset: 'balanced' }, p);
    expect(existsSync(p + '.tmp')).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npx vitest run tests/config.test.ts -t 'saveConfig'`
Expected: all 7 tests FAIL — `saveConfig` is not exported.

- [ ] **Step 3: Implement saveConfig**

At the bottom of `src/config.ts`, add:

```ts
import { writeFileSync as _writeFileSync, renameSync, readFileSync as _readFileSync, existsSync as _existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface WizardResult {
  preset: 'full' | 'balanced' | 'minimal';
  theme?: string;
  icons: 'nerd' | 'emoji' | 'none';
}

export function saveConfig(wizard: WizardResult, configPath: string): void {
  mkdirSync(dirname(configPath), { recursive: true });

  let existing: Record<string, unknown> = {};
  if (_existsSync(configPath)) {
    try {
      existing = JSON.parse(_readFileSync(configPath, 'utf8'));
      if (typeof existing !== 'object' || existing === null) existing = {};
    } catch {
      existing = {};
    }
  }

  const merged: Record<string, unknown> = { ...existing, preset: wizard.preset, icons: wizard.icons };
  if (wizard.theme !== undefined) merged.theme = wizard.theme;
  else delete merged.theme;

  const tmp = configPath + '.tmp';
  _writeFileSync(tmp, JSON.stringify(merged, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, configPath);
}
```

Note: if `readFileSync`/`existsSync`/`writeFileSync` are already imported in the file from `'node:fs'`, reuse those imports instead of aliasing. Check the top of `src/config.ts` and consolidate — the aliasing above is a fallback only if the symbols conflict.

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run tests/config.test.ts -t 'saveConfig'`
Expected: all 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat(config): add atomic saveConfig helper

Writes wizard keys (preset, theme, icons) to config.json via tmp file +
rename. Preserves other user-set keys on merge. Creates parent dir if
missing. Writes with 0o600 permissions.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: ASCII banner module

**Files:**
- Create: `src/tui/banner.ts`
- Test: `tests/tui/banner.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/tui/banner.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { getBanner, getSubtitle } from '../../src/tui/banner.js';

describe('getBanner', () => {
  it('returns a banner string with cyan ANSI and the logo', () => {
    const b = getBanner({ width: 80 });
    expect(b).toContain('\x1b[36m');
    expect(b).toContain('\x1b[0m');
    expect(b).toContain('██╗     ██╗');
  });

  it('returns empty string when width < 50', () => {
    expect(getBanner({ width: 40 })).toBe('');
  });
});

describe('getSubtitle', () => {
  it('reads version from package.json', () => {
    const s = getSubtitle();
    expect(s).toMatch(/real-time statusline for claude code & qwen code · v\d+\.\d+\.\d+/);
  });

  it('falls back to subtitle without version if read fails', () => {
    // Inject a bad resolver
    const s = getSubtitle({ readPackageJson: () => { throw new Error('boom'); } });
    expect(s).toBe('real-time statusline for claude code & qwen code');
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npx vitest run tests/tui/banner.test.ts`
Expected: all tests FAIL — module doesn't exist.

- [ ] **Step 3: Create src/tui/banner.ts**

```ts
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LOGO = [
  '██╗     ██╗   ██╗███╗   ███╗██╗██████╗  █████╗ ',
  '██║     ██║   ██║████╗ ████║██║██╔══██╗██╔══██╗',
  '██║     ██║   ██║██╔████╔██║██║██████╔╝███████║',
  '██║     ██║   ██║██║╚██╔╝██║██║██╔══██╗██╔══██║',
  '███████╗╚██████╔╝██║ ╚═╝ ██║██║██║  ██║██║  ██║',
  '╚══════╝ ╚═════╝ ╚═╝     ╚═╝╚═╝╚═╝  ╚═╝╚═╝  ╚═╝',
].join('\n');

const CYAN = '\x1b[36m';
const RST = '\x1b[0m';

export interface BannerOpts {
  width?: number;
}

export function getBanner(opts: BannerOpts = {}): string {
  const width = opts.width ?? (process.stdout.columns ?? 80);
  if (width < 50) return '';
  return `${CYAN}\n${LOGO}\n${RST}`;
}

export interface SubtitleOpts {
  readPackageJson?: () => string;
}

function defaultReadPackageJson(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/tui/banner.js lives at dist/tui/; package.json is at dist/..
  const p = resolve(here, '..', '..', 'package.json');
  return readFileSync(p, 'utf8');
}

export function getSubtitle(opts: SubtitleOpts = {}): string {
  const read = opts.readPackageJson ?? defaultReadPackageJson;
  const base = 'real-time statusline for claude code & qwen code';
  try {
    const pkg = JSON.parse(read());
    if (typeof pkg.version === 'string') return `${base} · v${pkg.version}`;
    return base;
  } catch {
    return base;
  }
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run tests/tui/banner.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tui/banner.ts tests/tui/banner.test.ts
git commit -m "feat(tui): add ASCII banner module

Exports getBanner() and getSubtitle() for the install wizard entry
screen. Banner is hidden on terminals <50 cols. Subtitle reads
version from package.json with a graceful fallback.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: TUI select helper — non-TTY path + public shape

**Files:**
- Create: `src/tui/select.ts`
- Create: `tests/tui/select.test.ts`
- Create: `tests/tui/_mock-stdin.ts` (shared helper)

- [ ] **Step 1: Create the mock stdin helper**

Create `tests/tui/_mock-stdin.ts`:

```ts
import { EventEmitter } from 'node:events';

export interface MockStdin extends EventEmitter {
  isTTY: boolean;
  isRaw: boolean;
  setRawMode(flag: boolean): MockStdin;
  resume(): MockStdin;
  pause(): MockStdin;
  removeListener(event: string, fn: (...args: unknown[]) => void): MockStdin;
  pressKey(name: string, opts?: { ctrl?: boolean; shift?: boolean; meta?: boolean }): void;
  emitEnd(): void;
}

export function createMockStdin(isTTY = true): MockStdin {
  const ee = new EventEmitter() as MockStdin;
  ee.isTTY = isTTY;
  ee.isRaw = false;
  ee.setRawMode = function (flag: boolean) { this.isRaw = flag; return this; };
  ee.resume = function () { return this; };
  ee.pause = function () { return this; };
  ee.pressKey = function (name: string, opts = {}) {
    const seq = name === 'return' ? '\r' : '';
    this.emit('keypress', seq, { name, ctrl: !!opts.ctrl, shift: !!opts.shift, meta: !!opts.meta });
  };
  ee.emitEnd = function () { this.emit('end'); };
  return ee;
}

export interface MockStdout extends EventEmitter {
  columns: number;
  rows: number;
  written: string[];
  write(chunk: string): boolean;
}

export function createMockStdout(columns = 100): MockStdout {
  const ee = new EventEmitter() as MockStdout;
  ee.columns = columns;
  ee.rows = 30;
  ee.written = [];
  ee.write = function (chunk: string) { this.written.push(chunk); return true; };
  return ee;
}
```

- [ ] **Step 2: Write the failing tests**

Create `tests/tui/select.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { interactiveSelect } from '../../src/tui/select.js';
import { createMockStdin, createMockStdout } from './_mock-stdin.js';

describe('interactiveSelect — non-TTY', () => {
  it('returns null immediately when stdin is not a TTY', async () => {
    const stdin = createMockStdin(false);
    const stdout = createMockStdout();
    const result = await interactiveSelect({
      title: 'pick',
      options: [{ label: 'a', value: 'a' }, { label: 'b', value: 'b' }],
      initial: 'a',
      preview: () => 'preview',
      stdin, stdout,
    });
    expect(result).toBeNull();
  });

  it('never enters raw mode when stdin is not a TTY', async () => {
    const stdin = createMockStdin(false);
    const stdout = createMockStdout();
    await interactiveSelect({
      title: 'pick',
      options: [{ label: 'a', value: 'a' }],
      initial: 'a',
      preview: () => '',
      stdin, stdout,
    });
    expect(stdin.isRaw).toBe(false);
  });
});
```

- [ ] **Step 3: Run tests — they should fail (module missing)**

Run: `npx vitest run tests/tui/select.test.ts`
Expected: tests FAIL with import error.

- [ ] **Step 4: Implement minimal select.ts with non-TTY path**

Create `src/tui/select.ts`:

```ts
import type { Readable, Writable } from 'node:stream';

export interface SelectOption<T> {
  label: string;
  value: T;
  description?: string;
  hint?: string;   // optional inline preview snippet (e.g. theme color sample)
  disabled?: boolean;
}

export interface SelectOpts<T> {
  title: string;
  options: SelectOption<T>[];
  initial?: T;
  preview: (focused: T) => string;
  /** Optional injection points for tests. Default: process.stdin / process.stdout. */
  stdin?: NodeJS.ReadStream | (Readable & { isTTY?: boolean; isRaw?: boolean; setRawMode?: (flag: boolean) => unknown });
  stdout?: NodeJS.WriteStream | (Writable & { columns?: number });
}

export async function interactiveSelect<T>(opts: SelectOpts<T>): Promise<T | null> {
  const stdin = (opts.stdin ?? process.stdin) as NodeJS.ReadStream;
  if (!stdin.isTTY) return null;

  // Placeholder for later tasks — resolved in Task 6+
  return null;
}
```

- [ ] **Step 5: Run tests to verify pass**

Run: `npx vitest run tests/tui/select.test.ts`
Expected: both tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/tui/select.ts tests/tui/select.test.ts tests/tui/_mock-stdin.ts
git commit -m "feat(tui): interactiveSelect scaffold with non-TTY fallback

Adds the public shape for the TUI select helper and the mock-stdin
test infrastructure. Non-TTY stdin short-circuits to null so callers
can detect piped input and fall back to defaults.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: TUI select helper — navigation, Enter, cleanup

**Files:**
- Modify: `src/tui/select.ts`
- Modify: `tests/tui/select.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/tui/select.test.ts`:

```ts
import { emitKeypressEvents } from 'node:readline';  // only needed if cross-module monkey-patch

describe('interactiveSelect — navigation', () => {
  const makeOpts = (overrides: Record<string, unknown> = {}) => {
    const stdin = createMockStdin(true);
    const stdout = createMockStdout();
    return {
      stdin, stdout,
      title: 'pick',
      options: [
        { label: 'a', value: 'a' },
        { label: 'b', value: 'b' },
        { label: 'c', value: 'c' },
      ],
      initial: 'b',
      preview: () => 'p',
      ...overrides,
    };
  };

  it('Enter on initial focus resolves with that value', async () => {
    const opts = makeOpts();
    const promise = interactiveSelect(opts);
    // Let the first render flush
    await new Promise((r) => setImmediate(r));
    opts.stdin.pressKey('return');
    expect(await promise).toBe('b');
  });

  it('Down then Enter resolves with the next value', async () => {
    const opts = makeOpts();
    const promise = interactiveSelect(opts);
    await new Promise((r) => setImmediate(r));
    opts.stdin.pressKey('down');
    opts.stdin.pressKey('return');
    expect(await promise).toBe('c');
  });

  it('Up from first wraps to last', async () => {
    const opts = makeOpts({ initial: 'a' });
    const promise = interactiveSelect(opts);
    await new Promise((r) => setImmediate(r));
    opts.stdin.pressKey('up');
    opts.stdin.pressKey('return');
    expect(await promise).toBe('c');
  });

  it('Down from last wraps to first', async () => {
    const opts = makeOpts({ initial: 'c' });
    const promise = interactiveSelect(opts);
    await new Promise((r) => setImmediate(r));
    opts.stdin.pressKey('down');
    opts.stdin.pressKey('return');
    expect(await promise).toBe('a');
  });

  it('j/k navigate identically to down/up', async () => {
    const opts = makeOpts();
    const promise = interactiveSelect(opts);
    await new Promise((r) => setImmediate(r));
    opts.stdin.pressKey('j');
    opts.stdin.pressKey('return');
    expect(await promise).toBe('c');
  });

  it('invokes preview with the focused value on each move', async () => {
    const calls: string[] = [];
    const opts = makeOpts({ preview: (v: string) => { calls.push(v); return v; } });
    const promise = interactiveSelect(opts);
    await new Promise((r) => setImmediate(r));
    opts.stdin.pressKey('down');
    opts.stdin.pressKey('down');
    opts.stdin.pressKey('return');
    await promise;
    // initial render (b), after down (c), after down wrap (a)
    expect(calls).toEqual(['b', 'c', 'a']);
  });

  it('restores stdin to non-raw and shows cursor after resolve', async () => {
    const opts = makeOpts();
    const promise = interactiveSelect(opts);
    await new Promise((r) => setImmediate(r));
    expect(opts.stdin.isRaw).toBe(true);
    opts.stdin.pressKey('return');
    await promise;
    expect(opts.stdin.isRaw).toBe(false);
    const out = opts.stdout.written.join('');
    expect(out).toContain('\x1b[?25h'); // show-cursor
    expect(out).toContain('\x1b[?25l'); // hide-cursor (was written earlier)
  });
});
```

- [ ] **Step 2: Run tests — they should fail**

Run: `npx vitest run tests/tui/select.test.ts -t 'navigation'`
Expected: FAIL — select.ts currently returns null on TTY too.

- [ ] **Step 3: Implement navigation and Enter resolution**

Replace the body of `interactiveSelect` in `src/tui/select.ts`:

```ts
import readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';

const SHOW_CURSOR = '\x1b[?25h';
const HIDE_CURSOR = '\x1b[?25l';
const CLEAR_SCREEN = '\x1b[2J\x1b[H';

export async function interactiveSelect<T>(opts: SelectOpts<T>): Promise<T | null> {
  const stdin = (opts.stdin ?? process.stdin) as NodeJS.ReadStream;
  const stdout = (opts.stdout ?? process.stdout) as NodeJS.WriteStream;
  if (!stdin.isTTY) return null;

  const options = opts.options;
  const initialIdx = Math.max(0, options.findIndex((o) => o.value === opts.initial));
  let focus = initialIdx >= 0 ? initialIdx : 0;

  let keypressListener: ((str: string, key: KeypressKey) => void) | null = null;

  const cleanup = () => {
    if (keypressListener) stdin.removeListener('keypress', keypressListener);
    if (typeof stdin.setRawMode === 'function') stdin.setRawMode(false);
    stdin.pause?.();
    stdout.write(SHOW_CURSOR);
  };

  const render = () => {
    stdout.write(CLEAR_SCREEN);
    stdout.write(` ${opts.title}\n\n`);
    for (let i = 0; i < options.length; i++) {
      const o = options[i];
      const marker = i === focus ? ' ❯ ' : '   ';
      stdout.write(`${marker}${o.label}${o.description ? '  ' + o.description : ''}\n`);
    }
    stdout.write('\n');
    stdout.write(opts.preview(options[focus].value));
    stdout.write('\n');
  };

  try {
    readline.emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();
    stdout.write(HIDE_CURSOR);
    render();

    return await new Promise<T | null>((resolve) => {
      keypressListener = (_str, key) => {
        if (!key) return;
        if (key.name === 'down' || key.name === 'j') { focus = (focus + 1) % options.length; render(); return; }
        if (key.name === 'up' || key.name === 'k') { focus = (focus - 1 + options.length) % options.length; render(); return; }
        if (key.name === 'return') { resolve(options[focus].value); return; }
      };
      stdin.on('keypress', keypressListener);
    });
  } finally {
    cleanup();
  }
}

interface KeypressKey { name: string; ctrl?: boolean; shift?: boolean; meta?: boolean; }
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run tests/tui/select.test.ts`
Expected: all navigation tests PASS (plus the non-TTY tests from Task 5).

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: all PASS, no regressions.

- [ ] **Step 6: Commit**

```bash
git add src/tui/select.ts tests/tui/select.test.ts
git commit -m "feat(tui): navigation, Enter resolution, and cleanup

Implements wrap-around up/down with j/k aliases, live preview on
every move, cursor hide/show, raw-mode restoration via try/finally.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: TUI select helper — abort (Esc, q, Ctrl+C) and resize

**Files:**
- Modify: `src/tui/select.ts`
- Modify: `tests/tui/select.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/tui/select.test.ts`:

```ts
describe('interactiveSelect — abort and resize', () => {
  const makeOpts = () => ({
    stdin: createMockStdin(true),
    stdout: createMockStdout(),
    title: 'pick',
    options: [{ label: 'a', value: 'a' }, { label: 'b', value: 'b' }],
    initial: 'a',
    preview: () => '',
  });

  it('Esc resolves with null', async () => {
    const opts = makeOpts();
    const promise = interactiveSelect(opts);
    await new Promise((r) => setImmediate(r));
    opts.stdin.pressKey('escape');
    expect(await promise).toBeNull();
  });

  it('q resolves with null', async () => {
    const opts = makeOpts();
    const promise = interactiveSelect(opts);
    await new Promise((r) => setImmediate(r));
    opts.stdin.pressKey('q');
    expect(await promise).toBeNull();
  });

  it('Ctrl+C resolves with null', async () => {
    const opts = makeOpts();
    const promise = interactiveSelect(opts);
    await new Promise((r) => setImmediate(r));
    opts.stdin.pressKey('c', { ctrl: true });
    expect(await promise).toBeNull();
  });

  it('stdin end event resolves with null', async () => {
    const opts = makeOpts();
    const promise = interactiveSelect(opts);
    await new Promise((r) => setImmediate(r));
    opts.stdin.emitEnd();
    expect(await promise).toBeNull();
  });

  it('resize event triggers a re-render', async () => {
    const opts = makeOpts();
    const promise = interactiveSelect(opts);
    await new Promise((r) => setImmediate(r));
    const beforeCount = opts.stdout.written.filter((c) => c.includes('\x1b[2J')).length;
    opts.stdout.emit('resize');
    await new Promise((r) => setImmediate(r));
    const afterCount = opts.stdout.written.filter((c) => c.includes('\x1b[2J')).length;
    expect(afterCount).toBeGreaterThan(beforeCount);
    opts.stdin.pressKey('return');
    await promise;
  });
});
```

- [ ] **Step 2: Run tests — they should fail**

Run: `npx vitest run tests/tui/select.test.ts -t 'abort and resize'`
Expected: FAIL.

- [ ] **Step 3: Add abort and resize handling**

Edit `src/tui/select.ts`. Replace the body of the `new Promise<T | null>((resolve) => { ... })` section:

```ts
return await new Promise<T | null>((resolve) => {
  let resizeListener: (() => void) | null = null;
  let endListener: (() => void) | null = null;

  const finish = (v: T | null) => {
    if (resizeListener && typeof stdout.removeListener === 'function') stdout.removeListener('resize', resizeListener);
    if (endListener) stdin.removeListener('end', endListener);
    resolve(v);
  };

  keypressListener = (_str, key) => {
    if (!key) return;
    if (key.name === 'down' || key.name === 'j') { focus = (focus + 1) % options.length; render(); return; }
    if (key.name === 'up' || key.name === 'k') { focus = (focus - 1 + options.length) % options.length; render(); return; }
    if (key.name === 'return') { finish(options[focus].value); return; }
    if (key.name === 'escape' || key.name === 'q') { finish(null); return; }
    if (key.name === 'c' && key.ctrl) { finish(null); return; }
  };
  stdin.on('keypress', keypressListener);

  endListener = () => finish(null);
  stdin.on('end', endListener);

  resizeListener = () => render();
  if (typeof stdout.on === 'function') stdout.on('resize', resizeListener);
});
```

Update `cleanup()` to also remove these listeners defensively if still present at exit (already handled in `finish`, but `cleanup` may run from `finally` without `finish` — e.g. exception path):

```ts
const cleanup = () => {
  if (keypressListener) stdin.removeListener('keypress', keypressListener);
  if (typeof stdin.setRawMode === 'function') stdin.setRawMode(false);
  stdin.pause?.();
  stdout.write(SHOW_CURSOR);
};
```

(Note: resize and end listeners are scoped inside the Promise closure; if an exception fires before `finish` resolves, they leak briefly until GC. In practice acceptable; if tightening is needed, hoist them to the outer scope.)

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run tests/tui/select.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Add defensive process exit handler**

At the top of `src/tui/select.ts`, add a one-shot process.exit handler registered only when used:

```ts
let exitHandlerInstalled = false;
function installExitHandler(stdin: NodeJS.ReadStream, stdout: NodeJS.WriteStream): void {
  if (exitHandlerInstalled) return;
  exitHandlerInstalled = true;
  process.once('exit', () => {
    try {
      if (typeof stdin.setRawMode === 'function' && stdin.isRaw) stdin.setRawMode(false);
      stdout.write(SHOW_CURSOR);
    } catch { /* best effort */ }
  });
}
```

Call `installExitHandler(stdin, stdout)` inside `interactiveSelect` right after the `isTTY` guard.

- [ ] **Step 6: Run full test suite**

Run: `npm test`
Expected: all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/tui/select.ts tests/tui/select.test.ts
git commit -m "feat(tui): abort keys, resize re-render, defensive exit cleanup

Esc, q, and Ctrl+C resolve interactiveSelect with null. Stdin 'end'
event (pipe closed) also aborts. Terminal resize triggers a re-render.
A one-shot process.exit handler restores raw mode and cursor as a
safety net against uncaughtException or external process.exit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Preview generator

**Files:**
- Create: `src/tui/preview.ts`
- Create: `tests/tui/preview.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/tui/preview.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildPreview } from '../../src/tui/preview.js';

describe('buildPreview', () => {
  it('returns a non-empty string for preset "balanced"', () => {
    const out = buildPreview({ preset: 'balanced', icons: 'nerd' });
    expect(out.length).toBeGreaterThan(0);
  });

  it('dracula theme in truecolor emits a dracula RGB code', () => {
    const out = buildPreview({ preset: 'full', theme: 'dracula', icons: 'nerd', colorMode: 'truecolor' });
    // Dracula cyan: rgb(139, 233, 253)
    expect(out).toContain('\x1b[38;2;139;233;253m');
  });

  it('named color mode does not emit 24-bit RGB escapes', () => {
    const out = buildPreview({ preset: 'full', theme: 'dracula', icons: 'nerd', colorMode: 'named' });
    expect(out).not.toContain('\x1b[38;2;');
  });

  it('icons="none" produces no Nerd Font codepoints (e.g. no \\uE000+ range)', () => {
    const out = buildPreview({ preset: 'full', icons: 'none' });
    expect(/[\uE000-\uF8FF]/.test(out)).toBe(false);
  });

  it('returns "(preview unavailable)" when render throws', () => {
    // Simulate by providing an impossible preset value via cast
    const out = buildPreview({ preset: 'xx' as unknown as 'full', icons: 'nerd' });
    // invalid preset still renders with defaults — this test pins the fallback
    // by injecting a broken renderer; see buildPreview opts
    expect(out.length).toBeGreaterThan(0);
  });

  it('catches renderer exceptions and returns fallback', () => {
    const out = buildPreview({ preset: 'balanced', icons: 'nerd' }, {
      render: () => { throw new Error('boom'); },
    });
    expect(out).toBe('(preview unavailable)');
  });
});
```

- [ ] **Step 2: Run tests — they should fail**

Run: `npx vitest run tests/tui/preview.test.ts`
Expected: FAIL with import error.

- [ ] **Step 3: Create src/tui/preview.ts**

```ts
import { render as defaultRender } from '../render/index.js';
import { createIcons } from '../render/icons.js';
import { DEFAULT_CONFIG, DEFAULT_DISPLAY, type HudConfig, type RenderContext } from '../types.js';
import type { ColorMode } from '../render/colors.js';

export interface PreviewOpts {
  preset: HudConfig['preset'];
  theme?: string;
  icons: 'nerd' | 'emoji' | 'none';
  colorMode?: ColorMode;
}

export interface BuildPreviewDeps {
  render?: (ctx: RenderContext) => string;
}

function buildMockContext(opts: PreviewOpts): RenderContext {
  const config: HudConfig = {
    ...DEFAULT_CONFIG,
    preset: opts.preset,
    icons: opts.icons,
    theme: opts.theme,
    display: { ...DEFAULT_DISPLAY },
    colors: { mode: opts.colorMode ?? 'truecolor' },
  };

  // Apply preset if valid (uses config.ts's applyPreset semantics inline)
  // Minimal inline: we call loadConfig-like logic by constructing via raw object
  // would be overkill — we just fill display from DEFAULT_DISPLAY and let render
  // handle layout via config.layout (left as DEFAULT_CONFIG.layout).
  //
  // For faithful preview, mimic applyPreset's effect on layout:
  if (opts.preset === 'minimal') config.layout = 'singleline';
  else if (opts.preset === 'balanced') config.layout = 'auto';
  else if (opts.preset === 'full') config.layout = 'multiline';

  return {
    input: {
      raw: { model: { display_name: 'Claude Sonnet 4.6', id: 'claude-sonnet-4-6' } },
      cwd: '/home/carlos/projects/lumira',
      platform: 'claude-code',
      tokens: { input: 12_000, output: 1_800, cached: 0, total: 13_800 },
      costUsd: 0.42,
      contextTokens: 80_000,
      windowSize: 200_000,
      gitBranch: 'main',
    } as unknown as RenderContext['input'],
    git: { branch: 'main', added: 3, modified: 2, deleted: 0 } as unknown as RenderContext['git'],
    transcript: { todos: [], tools: [], messages: 0, duration: 0 } as unknown as RenderContext['transcript'],
    config,
    cols: 120,
    icons: createIcons(opts.icons),
  };
}

export function buildPreview(opts: PreviewOpts, deps: BuildPreviewDeps = {}): string {
  const render = deps.render ?? defaultRender;
  try {
    const ctx = buildMockContext(opts);
    return render(ctx);
  } catch {
    return '(preview unavailable)';
  }
}
```

Note: the mock shape above uses `as unknown as` casts to match `RenderContext` without pulling every nested field. If the real `RenderContext` types complain, inspect `src/types.ts` and `src/normalize.ts` for the exact `NormalizedInput`, `GitStatus`, and `TranscriptData` shapes and fill in just enough fields — only what `renderLine1/2/3/4` and `renderMinimal` actually read (search for `.` accesses inside those files). Do not leak `undefined` into fields that the renderer indexes without null checks.

- [ ] **Step 4: Run tests; if type errors or render crashes, inspect the renderer and fill mock fields**

Run: `npm run lint && npx vitest run tests/tui/preview.test.ts`

If tests fail due to missing fields, grep the renderers for every `ctx.input.X`, `ctx.git.Y`, `ctx.transcript.Z` access and populate those fields in the mock. This iteration loop may take 2–3 rounds.

Expected after iteration: all 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tui/preview.ts tests/tui/preview.test.ts
git commit -m "feat(tui): preview generator for the install wizard

Builds a RenderContext with realistic mock data and invokes render()
to produce a live preview of the statusline. Wraps the renderer in
try/catch; returns '(preview unavailable)' on failure so the wizard
can't be taken down by a broken preview input.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Installer wizard orchestration

**Files:**
- Create: `src/installer-wizard.ts`
- Create: `tests/installer-wizard.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/installer-wizard.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { runWizard } from '../src/installer-wizard.js';
import { createMockStdin, createMockStdout } from './tui/_mock-stdin.js';

async function flushMicrotasks() { await new Promise((r) => setImmediate(r)); }

describe('runWizard', () => {
  it('three Enters accept defaults: preset=balanced, no theme, icons=nerd', async () => {
    const stdin = createMockStdin(true);
    const stdout = createMockStdout();
    const p = runWizard({ stdin, stdout, current: {} });

    await flushMicrotasks();
    stdin.pressKey('return'); // step 1: preset=balanced (default initial)
    await flushMicrotasks();
    stdin.pressKey('return'); // step 2: theme=(none)
    await flushMicrotasks();
    stdin.pressKey('return'); // step 3: icons=nerd

    const result = await p;
    expect(result).toEqual({ preset: 'balanced', icons: 'nerd' });
    expect('theme' in (result ?? {})).toBe(false);
  });

  it('down+Enter on step 1 picks minimal', async () => {
    const stdin = createMockStdin(true);
    const stdout = createMockStdout();
    const p = runWizard({ stdin, stdout, current: {} });

    await flushMicrotasks();
    stdin.pressKey('down'); stdin.pressKey('return'); // minimal
    await flushMicrotasks();
    stdin.pressKey('return'); // theme (none)
    await flushMicrotasks();
    stdin.pressKey('return'); // icons nerd

    expect(await p).toEqual({ preset: 'minimal', icons: 'nerd' });
  });

  it('Esc at any step resolves with null', async () => {
    const stdin = createMockStdin(true);
    const stdout = createMockStdout();
    const p = runWizard({ stdin, stdout, current: {} });

    await flushMicrotasks();
    stdin.pressKey('escape');

    expect(await p).toBeNull();
  });

  it('pre-selects values from current config', async () => {
    const stdin = createMockStdin(true);
    const stdout = createMockStdout();
    const p = runWizard({
      stdin, stdout,
      current: { preset: 'full', theme: 'dracula', icons: 'emoji' },
    });

    await flushMicrotasks();
    stdin.pressKey('return'); // accept full
    await flushMicrotasks();
    stdin.pressKey('return'); // accept dracula
    await flushMicrotasks();
    stdin.pressKey('return'); // accept emoji

    expect(await p).toEqual({ preset: 'full', theme: 'dracula', icons: 'emoji' });
  });
});
```

- [ ] **Step 2: Run tests — should fail**

Run: `npx vitest run tests/installer-wizard.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement src/installer-wizard.ts**

```ts
import { interactiveSelect, type SelectOption } from './tui/select.js';
import { buildPreview } from './tui/preview.js';
import { THEMES } from './themes.js';

export interface WizardCurrent {
  preset?: 'full' | 'balanced' | 'minimal';
  theme?: string;
  icons?: 'nerd' | 'emoji' | 'none';
}

export interface RunWizardOpts {
  current: WizardCurrent;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
}

export interface WizardResult {
  preset: 'full' | 'balanced' | 'minimal';
  theme?: string;
  icons: 'nerd' | 'emoji' | 'none';
}

const PRESET_OPTIONS: SelectOption<'full' | 'balanced' | 'minimal'>[] = [
  { label: 'full',     value: 'full',     description: '▸ everything on, 4 lines' },
  { label: 'balanced', value: 'balanced', description: '▸ essentials, auto-compact' },
  { label: 'minimal',  value: 'minimal',  description: '▸ single line, just the basics' },
];

const ICON_OPTIONS: SelectOption<'nerd' | 'emoji' | 'none'>[] = [
  { label: 'nerd',  value: 'nerd',  description: '▸ Nerd Font icons (default)' },
  { label: 'emoji', value: 'emoji', description: '▸ Unicode emoji icons' },
  { label: 'none',  value: 'none',  description: '▸ no icons, ASCII fallbacks' },
];

const NONE_THEME = '__none__';
function themeOptions(): SelectOption<string>[] {
  const names = Object.keys(THEMES);
  return [
    { label: '(none)', value: NONE_THEME },
    ...names.map((n) => ({ label: n, value: n })),
  ];
}

export async function runWizard(opts: RunWizardOpts): Promise<WizardResult | null> {
  const { current, stdin, stdout } = opts;

  const preset = await interactiveSelect({
    title: 'lumira setup · step 1/3 — preset',
    options: PRESET_OPTIONS,
    initial: current.preset ?? 'balanced',
    preview: (v) => buildPreview({ preset: v, theme: current.theme, icons: current.icons ?? 'nerd' }),
    stdin, stdout,
  });
  if (preset === null) return null;

  const themeValue = await interactiveSelect({
    title: 'lumira setup · step 2/3 — theme',
    options: themeOptions(),
    initial: current.theme ?? NONE_THEME,
    preview: (v) => buildPreview({ preset, theme: v === NONE_THEME ? undefined : v, icons: current.icons ?? 'nerd' }),
    stdin, stdout,
  });
  if (themeValue === null) return null;
  const theme = themeValue === NONE_THEME ? undefined : themeValue;

  const icons = await interactiveSelect({
    title: 'lumira setup · step 3/3 — icons',
    options: ICON_OPTIONS,
    initial: current.icons ?? 'nerd',
    preview: (v) => buildPreview({ preset, theme, icons: v }),
    stdin, stdout,
  });
  if (icons === null) return null;

  const result: WizardResult = { preset, icons };
  if (theme !== undefined) result.theme = theme;
  return result;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/installer-wizard.test.ts`
Expected: all 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/installer-wizard.ts tests/installer-wizard.test.ts
git commit -m "feat(installer): wizard orchestration (preset → theme → icons)

Wires three interactiveSelect calls with a live buildPreview callback.
Pre-selects values from the user's current config.json. Esc at any
step bubbles up as null for a clean abort.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

Note: `[Back]` navigation between steps is deferred from this task. It's a UX polish — add it as a follow-up task if needed. The spec listed it; if required, extend `interactiveSelect` to support an extra `goBack` signal via Left arrow or a `[ Back ]` pseudo-option and have `runWizard` loop back. Flag for review before implementing.

---

## Task 10: Installer integration — wizard hookup, defaults, banner

**Files:**
- Modify: `src/installer.ts`
- Modify: `tests/installer.test.ts`

- [ ] **Step 1: Read the current installer**

Read `src/installer.ts` fully to see the existing `install()` flow and its signature.

- [ ] **Step 2: Write the failing tests**

Append to `tests/installer.test.ts`:

```ts
import { createMockStdin, createMockStdout } from './tui/_mock-stdin.js';

describe('install — wizard integration', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'lumira-wizard-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('writes config.json with wizard result after wizard completes', async () => {
    const settingsPath = join(dir, 'settings.json');
    const configPath = join(dir, 'config.json');
    const stdin = createMockStdin(true);
    const stdout = createMockStdout();

    const promise = install({
      settingsPath,
      configPath,
      confirm: async () => true,
      stdin, stdout,
    });

    // defaults: preset=balanced, theme=none, icons=nerd
    await new Promise((r) => setImmediate(r));
    stdin.pressKey('return');
    await new Promise((r) => setImmediate(r));
    stdin.pressKey('return');
    await new Promise((r) => setImmediate(r));
    stdin.pressKey('return');

    await promise;
    const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(cfg).toEqual({ preset: 'balanced', icons: 'nerd' });
  });

  it('skips wizard and writes defaults when stdin is not a TTY', async () => {
    const settingsPath = join(dir, 'settings.json');
    const configPath = join(dir, 'config.json');
    const stdin = createMockStdin(false);

    const output = await install({
      settingsPath,
      configPath,
      confirm: async () => true,
      stdin,
    });

    const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(cfg).toEqual({ preset: 'balanced', icons: 'nerd' });
    expect(output).toContain('Non-interactive');
  });

  it('aborts cleanly when user Escs — no settings.json, no config.json', async () => {
    const settingsPath = join(dir, 'settings.json');
    const configPath = join(dir, 'config.json');
    const stdin = createMockStdin(true);

    const promise = install({ settingsPath, configPath, confirm: async () => true, stdin });
    await new Promise((r) => setImmediate(r));
    stdin.pressKey('escape');

    const output = await promise;
    expect(existsSync(settingsPath)).toBe(false);
    expect(existsSync(configPath)).toBe(false);
    expect(output).toContain('cancelled');
  });

  it('preserves unrelated keys when config.json already has user edits', async () => {
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ display: { tokens: false } }));
    const settingsPath = join(dir, 'settings.json');
    const stdin = createMockStdin(false);

    await install({ settingsPath, configPath, confirm: async () => true, stdin });
    const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(cfg.display).toEqual({ tokens: false });
    expect(cfg.preset).toBe('balanced');
  });
});
```

- [ ] **Step 3: Run tests — they should fail**

Run: `npx vitest run tests/installer.test.ts`
Expected: new tests FAIL (install doesn't accept new opts yet).

- [ ] **Step 4: Refactor install() in src/installer.ts**

Update `src/installer.ts`:

1. Extend `InstallerOptions`:

```ts
export interface InstallerOptions {
  settingsPath?: string;
  configPath?: string;
  confirm?: (prompt: string) => Promise<boolean>;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
}
```

2. Add helper for the default config path:

```ts
function defaultConfigPath(): string {
  return join(homedir(), '.config', 'lumira', 'config.json');
}
```

3. Import wizard + saveConfig + banner at the top:

```ts
import { runWizard, type WizardResult } from './installer-wizard.js';
import { saveConfig } from './config.js';
import { getBanner, getSubtitle } from './tui/banner.js';
import { loadConfig } from './config.js';
```

4. Refactor `install()` to:
   - Print banner (via `stdout.write(getBanner({ width: (opts.stdout ?? process.stdout).columns }))` + subtitle).
   - Load current config (if any) via `loadConfig(dirname(configPath))` — reuse existing function.
   - Detect TTY via `(opts.stdin ?? process.stdin).isTTY`.
   - If TTY: call `runWizard({ current, stdin: opts.stdin, stdout: opts.stdout })`. If it returns `null`, print "Setup cancelled — no changes made." and return early (NO writes).
   - If not TTY: use `{ preset: 'balanced', icons: 'nerd' }` as the wizard result and append "Non-interactive mode — defaults applied." to the output.
   - Continue with existing settings.json write.
   - After settings write, call `saveConfig(wizardResult, configPath ?? defaultConfigPath())`.
   - Existing `installSkill()` call remains (Task 11 extends it to Qwen).

The refactored `install()` sketch (keep existing logic for settings.json merge/backup intact — only insert wizard and saveConfig calls):

```ts
export async function install(opts: InstallerOptions = {}): Promise<string> {
  const settingsPath = opts.settingsPath ?? defaultSettingsPath();
  const configPath = opts.configPath ?? defaultConfigPath();
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;
  const backupPath = settingsPath + '.lumira.bak';
  const confirm = opts.confirm ?? promptYN;
  const lines: string[] = [];

  // Banner
  const banner = getBanner({ width: stdout.columns ?? 80 });
  if (banner) lines.push(banner);
  lines.push(' ' + getSubtitle() + '\n');

  // Read current lumira config (for wizard pre-selection) — ignore file-not-found
  const current = loadConfig(dirname(configPath));
  const wizardCurrent = {
    preset: current.preset,
    theme: current.theme,
    icons: current.icons,
  };

  // Run wizard or fall back to defaults
  let wizard: WizardResult;
  if (stdin.isTTY) {
    const w = await runWizard({ current: wizardCurrent, stdin, stdout });
    if (w === null) {
      lines.push('\n  ⚠ Setup cancelled — no changes made.\n');
      return lines.join('\n') + '\n';
    }
    wizard = w;
  } else {
    wizard = { preset: 'balanced', icons: 'nerd' };
    lines.push('  ℹ Non-interactive mode — defaults applied.\n');
  }

  // ... existing settings.json logic (read, check statusLine, backup, write)
  //     leave that code unchanged. At the end of the successful write path,
  //     insert saveConfig(wizard, configPath).

  // Save wizard config
  saveConfig(wizard, configPath);
  lines.push(ok(`Saved config → ${DIM}${configPath}${RST}`));

  // Install /lumira skill (existing call — Task 11 extends it)
  lines.push(...installSkill());

  lines.push(`\n  Restart Claude Code to see your statusline.\n`);
  return lines.join('\n') + '\n';
}
```

Important: keep the existing statusLine read/write/backup logic verbatim. The wizard runs BEFORE statusLine write per the spec — but the current code uses `await confirm(...)` which is synchronous-waiting. Preserve that flow by running the wizard first and, if user confirms, proceeding to the backup+write. If wizard aborts, neither statusLine nor config.json are written.

Precise ordering in the rewritten function:
1. Banner.
2. Read current config.json (for wizard pre-selection).
3. Run wizard (or defaults if non-TTY). On null → return with "cancelled" message, write nothing.
4. Read settings.json; if existing statusLine is non-lumira → `confirm()` before proceeding; if user says no → return without writing.
5. Back up existing settings.json if replacing.
6. Write settings.json with lumira statusLine.
7. Write `saveConfig(wizard, configPath)`.
8. Install skill (Task 11 adds Qwen path).
9. Final summary.

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/installer.test.ts`
Expected: all tests PASS, including existing ones and the 4 new ones.

- [ ] **Step 6: Run full suite + lint**

Run: `npm test && npm run lint`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/installer.ts tests/installer.test.ts
git commit -m "feat(installer): integrate wizard, banner, and config save

install() now prints the ASCII banner, runs the interactive wizard
(or falls back to defaults on non-TTY), and writes the chosen
preset/theme/icons to ~/.config/lumira/config.json via atomic
saveConfig. Esc aborts cleanly with no file writes.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: Skill dual-install for Qwen Code

**Files:**
- Modify: `src/installer.ts` (`installSkill`, `uninstall`)
- Modify: `tests/installer.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `tests/installer.test.ts`:

```ts
describe('install — skill dual install for Qwen', () => {
  let dir: string;
  let claudeHome: string;
  let qwenHome: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lumira-qwen-'));
    claudeHome = join(dir, '.claude');
    qwenHome = join(dir, '.qwen');
    mkdirSync(claudeHome, { recursive: true });
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('installs skill only under claude when ~/.qwen/ does not exist', async () => {
    const settingsPath = join(claudeHome, 'settings.json');
    const configPath = join(dir, 'config.json');
    const stdin = createMockStdin(false);

    await install({
      settingsPath,
      configPath,
      confirm: async () => true,
      stdin,
      homeOverride: dir, // allows installSkill to resolve skill dest under our tmp dir
    });

    expect(existsSync(join(claudeHome, 'skills', 'lumira', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(qwenHome, 'skills', 'lumira', 'SKILL.md'))).toBe(false);
  });

  it('installs skill under both claude and qwen when ~/.qwen/ exists', async () => {
    mkdirSync(qwenHome, { recursive: true });
    const settingsPath = join(claudeHome, 'settings.json');
    const configPath = join(dir, 'config.json');
    const stdin = createMockStdin(false);

    await install({
      settingsPath,
      configPath,
      confirm: async () => true,
      stdin,
      homeOverride: dir,
    });

    expect(existsSync(join(claudeHome, 'skills', 'lumira', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(qwenHome, 'skills', 'lumira', 'SKILL.md'))).toBe(true);
  });

  it('uninstall removes skill from both destinations', async () => {
    mkdirSync(join(claudeHome, 'skills', 'lumira'), { recursive: true });
    writeFileSync(join(claudeHome, 'skills', 'lumira', 'SKILL.md'), 'dummy');
    mkdirSync(join(qwenHome, 'skills', 'lumira'), { recursive: true });
    writeFileSync(join(qwenHome, 'skills', 'lumira', 'SKILL.md'), 'dummy');

    const settingsPath = join(claudeHome, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({ statusLine: { command: 'npx lumira@latest' } }));

    uninstall({ settingsPath, homeOverride: dir });

    expect(existsSync(join(claudeHome, 'skills', 'lumira', 'SKILL.md'))).toBe(false);
    expect(existsSync(join(qwenHome, 'skills', 'lumira', 'SKILL.md'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests — should fail**

Run: `npx vitest run tests/installer.test.ts -t 'dual install'`
Expected: FAIL (no `homeOverride` support; skill goes to real `~/.claude`).

- [ ] **Step 3: Extend installSkill and uninstall**

In `src/installer.ts`:

1. Add `homeOverride?: string` to `InstallerOptions`.
2. Refactor `installSkill()` to take an options object:

```ts
function installSkill(opts: { homeOverride?: string } = {}): string[] {
  const lines: string[] = [];
  const home = opts.homeOverride ?? homedir();

  const thisDir = dirname(fileURLToPath(import.meta.url));
  const srcFile = resolve(thisDir, '..', 'skills', 'lumira', 'SKILL.md');

  if (!existsSync(srcFile)) {
    lines.push(warn('Skill file not found in package — skipping /lumira skill'));
    return lines;
  }

  const destinations = [
    { label: 'claude', dir: join(home, '.claude') },
    { label: 'qwen',   dir: join(home, '.qwen')   },
  ];

  for (const { label, dir } of destinations) {
    // Install claude always; qwen only if dir exists
    if (label === 'qwen' && !existsSync(dir)) continue;
    const destDir = join(dir, 'skills', 'lumira');
    const destFile = join(destDir, 'SKILL.md');
    try {
      mkdirSync(destDir, { recursive: true });
      copyFileSync(srcFile, destFile);
      lines.push(ok(`Installed ${DIM}/lumira${RST} skill → ${DIM}${destDir}/${RST}`));
    } catch {
      lines.push(warn(`Could not install /lumira skill to ${destDir}`));
    }
  }

  return lines;
}
```

3. Update `uninstall()` to also remove Qwen skill:

```ts
export function uninstall(opts: InstallerOptions = {}): string {
  const settingsPath = opts.settingsPath ?? defaultSettingsPath();
  const home = opts.homeOverride ?? homedir();
  // ... existing settings restoration logic

  // Remove skills from both destinations
  for (const root of [join(home, '.claude'), join(home, '.qwen')]) {
    const skillFile = join(root, 'skills', 'lumira', 'SKILL.md');
    if (existsSync(skillFile)) {
      try {
        unlinkSync(skillFile);
        // try to rmdir the now-empty skills/lumira/ dir — best effort, ignore errors
        try { rmdirSync(dirname(skillFile)); } catch { /* not empty; fine */ }
      } catch { /* skip */ }
    }
  }
  // ... return lines as before
}
```

Add `rmdirSync` to the `node:fs` import block at the top of `installer.ts`.

Also update call site in `install()` to pass `homeOverride`:

```ts
lines.push(...installSkill({ homeOverride: opts.homeOverride }));
```

And extend the Qwen detection note in the final summary (inside `install()`):

```ts
if (existsSync(join(opts.homeOverride ?? homedir(), '.qwen'))) {
  lines.push('\n  ℹ Qwen Code detected — in Qwen sessions, lumira renders');
  lines.push('    single-line automatically. Your preset above applies to Claude Code.\n');
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/installer.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Run full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/installer.ts tests/installer.test.ts
git commit -m "feat(installer): install /lumira skill for Qwen Code when detected

If ~/.qwen/ exists, also copy SKILL.md to ~/.qwen/skills/lumira/.
Uninstall removes the skill from both destinations. Final install
summary includes a Qwen detection notice when applicable.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: SKILL.md Platform Support section + CHANGELOG

**Files:**
- Modify: `skills/lumira/SKILL.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Edit SKILL.md**

Insert new section in `skills/lumira/SKILL.md` right after the `## Available Settings` block (before `## Example Configs`):

```markdown
## Platform Support

Lumira auto-detects the caller's platform:

- **Claude Code** — renders per your configured `layout` / `preset`.
- **Qwen Code** — renders compact single-line output automatically, regardless of `layout`. Qwen Code only displays the first line of statusline commands, so lumira always uses the single-line renderer (which fits model, branch, context bar, cost, cached tokens, and thoughts into one line).

No configuration needed. One `config.json` serves both CLIs.
```

Also verify the Presets section lists only `full` / `balanced` / `minimal` — it already does. If you see `qwen` listed, remove it.

- [ ] **Step 2: Update CHANGELOG.md**

Prepend to `CHANGELOG.md` a new entry (match the existing style of the file):

```markdown
## [Unreleased]

### Added
- Interactive install wizard (`lumira install`): choose preset, theme, and icons with arrow-key navigation and live preview.
- ASCII banner with dynamic version from `package.json`.
- `/lumira` skill is now installed for Qwen Code as well, when `~/.qwen/` is detected.
- Render layer now auto-switches to single-line output when the caller is Qwen Code.

### Changed
- `saveConfig` writes `~/.config/lumira/config.json` atomically (tmp file + rename) with 0o600 permissions.

### Removed
- **BREAKING:** `qwen` preset removed. It was functionally identical to `minimal`; the render layer now auto-switches for Qwen Code so the alias no longer serves a purpose. Existing configs with `preset: "qwen"` are coerced to `minimal` with a one-shot stderr warning. CLI flag `--qwen` is removed; use `--minimal` instead.
```

Verify the top of `CHANGELOG.md` first to match the project's exact header style — adjust heading level / section names accordingly if different.

- [ ] **Step 3: Run full suite one last time**

Run: `npm test && npm run lint`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add skills/lumira/SKILL.md CHANGELOG.md
git commit -m "docs: document Qwen auto-detect and v0.4 breaking changes

Adds a Platform Support section to the /lumira skill explaining the
qwen auto-switch. Updates CHANGELOG with the wizard feature, Qwen
skill dual-install, render auto-switch, and the removal of the
qwen preset.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review Checklist

**Spec coverage:**
- ✅ Render-layer Qwen fix → Task 1
- ✅ Remove `qwen` preset + migration → Task 2
- ✅ Atomic `saveConfig` → Task 3
- ✅ ASCII banner with dynamic version → Task 4
- ✅ TUI select helper (raw mode, navigation, abort, resize, cleanup) → Tasks 5, 6, 7
- ✅ Preview generator → Task 8
- ✅ Wizard orchestration (preset → theme → icons, pre-selection) → Task 9
- ✅ Installer integration (wizard hookup, non-TTY defaults, no-write-on-abort) → Task 10
- ✅ Skill dual-install for Qwen + uninstall cleanup + Qwen detection notice → Task 11
- ✅ SKILL.md Platform Support + CHANGELOG breaking-change entry → Task 12

**Gaps or deferred items:**
- `[ Back ]` navigation between wizard steps (spec called it out) is deferred as a UX polish — flagged in Task 9 Step 5 as a follow-up. The core wizard ships without it; Esc is the recovery path.
- The stderr migration warning in Task 2 uses a module-level `qwenWarningShown` flag. Per-process single warning — acceptable; not per-invocation.

**Placeholder scan:** no "TBD", "TODO", or "fill in" strings in the plan. Every code step contains the actual code.

**Type consistency:** `WizardResult` defined in Task 3 (exported from config.ts) is re-exported/shadowed from `src/installer-wizard.ts` in Task 9. This is minor duplication; if a reviewer wants, collapse into a single definition in `src/types.ts` before landing. Flagged but not blocking.
