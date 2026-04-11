# Lumira Installer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `npx lumira install` and `npx lumira uninstall` commands that auto-configure Claude Code's settings.json with backup/restore support.

**Architecture:** Single new file `src/installer.ts` with pure functions for install/uninstall logic (DI for paths and I/O). Entry point in `src/index.ts` intercepts `install`/`uninstall` argv before stdin reading. All output uses raw ANSI codes — no new dependencies.

**Tech Stack:** Node.js fs, readline, ANSI escape codes

---

### File Map

- **Create:** `src/installer.ts` — install/uninstall logic with styled output
- **Create:** `tests/installer.test.ts` — all 8 test cases
- **Modify:** `src/index.ts` — intercept install/uninstall subcommands before stdin

---

### Task 1: Installer core — install logic

**Files:**
- Create: `src/installer.ts`
- Create: `tests/installer.test.ts`

- [ ] **Step 1: Write failing tests for install scenarios**

Create `tests/installer.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { install } from '../src/installer.js';

describe('install', () => {
  let dir: string;
  let settingsPath: string;
  let backupPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lumira-test-'));
    settingsPath = join(dir, 'settings.json');
    backupPath = join(dir, 'settings.json.lumira.bak');
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('creates settings file when none exists', async () => {
    const output = await install({ settingsPath, confirm: async () => true });
    expect(existsSync(settingsPath)).toBe(true);
    const data = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(data.statusLine.command).toBe('npx lumira@latest');
    expect(output).toContain('Configured');
  });

  it('adds statusLine when settings exists without one', async () => {
    writeFileSync(settingsPath, JSON.stringify({ hooks: {} }, null, 2));
    const output = await install({ settingsPath, confirm: async () => true });
    const data = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(data.statusLine.command).toBe('npx lumira@latest');
    expect(data.hooks).toEqual({});
    expect(existsSync(backupPath)).toBe(false);
  });

  it('backs up and replaces existing statusLine after confirmation', async () => {
    const original = { statusLine: { type: 'command', command: 'other-tool', padding: 0 } };
    writeFileSync(settingsPath, JSON.stringify(original, null, 2));
    const output = await install({ settingsPath, confirm: async () => true });
    expect(existsSync(backupPath)).toBe(true);
    const backup = JSON.parse(readFileSync(backupPath, 'utf8'));
    expect(backup.statusLine.command).toBe('other-tool');
    const data = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(data.statusLine.command).toBe('npx lumira@latest');
    expect(output).toContain('Backed up');
  });

  it('skips when already configured with lumira', async () => {
    const existing = { statusLine: { type: 'command', command: 'npx lumira@latest', padding: 0 } };
    writeFileSync(settingsPath, JSON.stringify(existing, null, 2));
    const output = await install({ settingsPath, confirm: async () => true });
    expect(output).toContain('already configured');
    expect(existsSync(backupPath)).toBe(false);
  });

  it('aborts when user declines replacement', async () => {
    const original = { statusLine: { type: 'command', command: 'other-tool', padding: 0 } };
    writeFileSync(settingsPath, JSON.stringify(original, null, 2));
    const output = await install({ settingsPath, confirm: async () => false });
    const data = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(data.statusLine.command).toBe('other-tool');
    expect(output).toContain('Aborted');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/installer.test.ts`
Expected: FAIL — module `../src/installer.js` not found

- [ ] **Step 3: Implement install function**

Create `src/installer.ts`:

```ts
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';

// ── ANSI helpers ────────────────────────────────────────────────────
const RST = '\x1b[0m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';

const ok = (msg: string) => `${GREEN}✓${RST} ${msg}`;
const warn = (msg: string) => `${YELLOW}⚠${RST} ${msg}`;
const header = () => `\n${CYAN} lumira installer${RST}\n`;

// ── StatusLine value ────────────────────────────────────────────────
const LUMIRA_STATUSLINE = {
  type: 'command' as const,
  command: 'npx lumira@latest',
  padding: 0,
};

// ── Install options (DI for testing) ────────────────────────────────
export interface InstallerOptions {
  settingsPath?: string;
  confirm?: (prompt: string) => Promise<boolean>;
}

function defaultSettingsPath(): string {
  return join(homedir(), '.claude', 'settings.json');
}

function isLumira(statusLine: unknown): boolean {
  if (!statusLine || typeof statusLine !== 'object') return false;
  const sl = statusLine as Record<string, unknown>;
  return typeof sl.command === 'string' && sl.command.includes('lumira');
}

// ── Prompt helper ───────────────────────────────────────────────────
export function promptYN(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${question} (y/N) `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}

// ── Install ─────────────────────────────────────────────────────────
export async function install(opts: InstallerOptions = {}): Promise<string> {
  const settingsPath = opts.settingsPath ?? defaultSettingsPath();
  const backupPath = settingsPath + '.lumira.bak';
  const confirm = opts.confirm ?? promptYN;
  const lines: string[] = [header()];

  let settings: Record<string, unknown> = {};

  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    } catch {
      lines.push(warn('Could not parse existing settings.json, creating fresh'));
      settings = {};
    }
  }

  if (settings.statusLine) {
    if (isLumira(settings.statusLine)) {
      lines.push(ok('lumira is already configured as your statusline'));
      return lines.join('\n') + '\n';
    }

    const current = (settings.statusLine as Record<string, unknown>).command ?? 'unknown';
    lines.push(warn(`Current statusline: ${YELLOW}${current}${RST}`));
    const accepted = await confirm('Replace with lumira?');
    if (!accepted) {
      lines.push(`\n  Aborted. No changes made.\n`);
      return lines.join('\n') + '\n';
    }

    copyFileSync(settingsPath, backupPath);
    lines.push(ok(`Backed up existing settings → ${DIM}settings.json.lumira.bak${RST}`));
  }

  settings.statusLine = { ...LUMIRA_STATUSLINE };
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
  lines.push(ok('Configured lumira as statusline'));
  lines.push(`\n  Restart Claude Code to see your statusline.\n`);
  return lines.join('\n') + '\n';
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/installer.test.ts`
Expected: all 5 install tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/installer.ts tests/installer.test.ts
git commit -m "feat: add install command with backup support"
```

---

### Task 2: Uninstall logic

**Files:**
- Modify: `src/installer.ts`
- Modify: `tests/installer.test.ts`

- [ ] **Step 1: Write failing tests for uninstall scenarios**

Append to `tests/installer.test.ts`:

```ts
import { install, uninstall } from '../src/installer.js';

// ... (update the import at top of file)

describe('uninstall', () => {
  let dir: string;
  let settingsPath: string;
  let backupPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lumira-test-'));
    settingsPath = join(dir, 'settings.json');
    backupPath = join(dir, 'settings.json.lumira.bak');
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('restores from backup when backup exists', () => {
    const backup = { statusLine: { type: 'command', command: 'old-tool', padding: 0 }, hooks: {} };
    const current = { statusLine: { type: 'command', command: 'npx lumira@latest', padding: 0 }, hooks: {} };
    writeFileSync(backupPath, JSON.stringify(backup, null, 2));
    writeFileSync(settingsPath, JSON.stringify(current, null, 2));
    const output = uninstall({ settingsPath });
    const data = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(data.statusLine.command).toBe('old-tool');
    expect(existsSync(backupPath)).toBe(false);
    expect(output).toContain('Restored');
  });

  it('removes statusLine key when no backup exists', () => {
    const current = { statusLine: { type: 'command', command: 'npx lumira@latest', padding: 0 }, hooks: {} };
    writeFileSync(settingsPath, JSON.stringify(current, null, 2));
    const output = uninstall({ settingsPath });
    const data = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(data.statusLine).toBeUndefined();
    expect(data.hooks).toEqual({});
    expect(output).toContain('Removed');
  });

  it('prints message when no settings file exists', () => {
    const output = uninstall({ settingsPath });
    expect(output).toContain('Nothing to uninstall');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/installer.test.ts`
Expected: FAIL — `uninstall` is not exported

- [ ] **Step 3: Implement uninstall function**

Add to `src/installer.ts`:

```ts
// ── Uninstall ───────────────────────────────────────────────────────
export function uninstall(opts: InstallerOptions = {}): string {
  const settingsPath = opts.settingsPath ?? defaultSettingsPath();
  const backupPath = settingsPath + '.lumira.bak';
  const lines: string[] = [header()];

  if (!existsSync(settingsPath)) {
    lines.push(ok('Nothing to uninstall — no settings.json found'));
    return lines.join('\n') + '\n';
  }

  if (existsSync(backupPath)) {
    copyFileSync(backupPath, settingsPath);
    unlinkSync(backupPath);
    lines.push(ok('Restored previous settings from backup'));
    lines.push(`\n  Restart Claude Code to apply changes.\n`);
    return lines.join('\n') + '\n';
  }

  try {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    delete settings.statusLine;
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
    lines.push(ok('Removed lumira statusline from settings'));
  } catch {
    lines.push(warn('Could not parse settings.json'));
  }

  lines.push(`\n  Restart Claude Code to apply changes.\n`);
  return lines.join('\n') + '\n';
}
```

Also add `unlinkSync` to the import at the top of `src/installer.ts`:

```ts
import { readFileSync, writeFileSync, existsSync, copyFileSync, unlinkSync } from 'node:fs';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/installer.test.ts`
Expected: all 8 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/installer.ts tests/installer.test.ts
git commit -m "feat: add uninstall command with backup restore"
```

---

### Task 3: Wire into index.ts entry point

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add subcommand detection to index.ts**

Add import at top of `src/index.ts`:

```ts
import { install, uninstall } from './installer.js';
```

Replace the bottom section (the "Run when invoked directly" block) with:

```ts
// Run when invoked directly
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && (__filename === process.argv[1] || __filename === process.argv[1] + '.js')) {
  const cmd = process.argv[2];
  if (cmd === 'install') {
    install().then(o => process.stdout.write(o)).catch(e => process.stderr.write(`Install error: ${e.message}\n`));
  } else if (cmd === 'uninstall') {
    const o = uninstall();
    process.stdout.write(o);
  } else {
    main().then(o => process.stdout.write(o)).catch(e => { if (!(e instanceof SyntaxError)) process.stderr.write(`Statusline error: ${e.message}\n`); });
  }
}
```

- [ ] **Step 2: Build and verify**

Run: `npm run build`
Expected: compiles with no errors

- [ ] **Step 3: Run full test suite**

Run: `npm test`
Expected: all tests pass (136 existing + 8 new = 144)

- [ ] **Step 4: Manual smoke test**

Run: `node dist/installer.js` — should not crash (no-op since not invoked via index)
Run: `node dist/index.js install` in a temp environment or inspect the output

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire install/uninstall subcommands into entry point"
```

---

### Task 4: Update README with install instructions

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the Install section of README.md**

Replace the current Install section with:

```markdown
## Install

Quick setup (auto-configures Claude Code):

```bash
npx lumira install
```

Or install globally:

```bash
npm install -g lumira
lumira install
```

To uninstall:

```bash
npx lumira uninstall
```

### Manual setup

Add to `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "npx lumira@latest",
    "padding": 0
  }
}
```
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: update README with npx lumira install instructions"
```
