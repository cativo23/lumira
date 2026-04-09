# Lumira Installer Design

## Overview

Interactive installer/uninstaller for lumira that configures Claude Code's `~/.claude/settings.json` automatically, with backup/restore support.

## Entry Point

Subcommands detected in `src/index.ts` before stdin reading:
- `lumira install` → delegates to installer
- `lumira uninstall` → delegates to uninstaller

No separate bin entry needed — single entry point handles both modes.

## New File: `src/installer.ts`

Exports: `runInstall()`, `runUninstall()`

### Install Flow

1. Resolve `~/.claude/settings.json`
2. If file doesn't exist: create with `{ "statusLine": ... }` and done
3. If file exists, parse JSON:
   a. If no `statusLine` key: add it, write back
   b. If `statusLine` exists and already is lumira: print "already configured", exit
   c. If `statusLine` exists with something else:
      - Print current command in yellow
      - Prompt `Replace with lumira? (y/N)` via stdin
      - If yes: backup to `settings.json.lumira.bak`, replace, write
      - If no: abort with message
4. Print success summary with green checkmarks

### Uninstall Flow

1. If `settings.json.lumira.bak` exists: restore it over `settings.json`, delete backup
2. If no backup: read `settings.json`, delete `statusLine` key, write back
3. If no `settings.json`: print "nothing to uninstall"
4. Print summary

### StatusLine Value Written

```json
{
  "statusLine": {
    "type": "command",
    "command": "npx lumira@latest",
    "padding": 0
  }
}
```

### Styled Output

ANSI codes used directly (no dependencies):
- `\x1b[32m` green for checkmarks (✓)
- `\x1b[33m` yellow for warnings/current config
- `\x1b[36m` cyan for headers
- `\x1b[2m` dim for paths
- `\x1b[0m` reset

Example output:
```
 lumira installer

✓ Backed up existing settings → settings.json.lumira.bak
✓ Configured lumira as statusline

  Restart Claude Code to see your statusline.
```

### Prompt (y/N)

Simple stdin readline — no dependencies:
```ts
import { createInterface } from 'node:readline';
```

Default is No (capital N) — safe by default.

### JSON Handling

- Read with `readFileSync` + `JSON.parse`
- Write with `JSON.stringify(data, null, 2)` to preserve readable formatting
- Preserve all existing keys — only touch `statusLine`

## Changes to `src/index.ts`

Before the stdin reading logic, check `process.argv`:
```ts
if (process.argv.includes('install')) { runInstall(); }
else if (process.argv.includes('uninstall')) { runUninstall(); }
else { /* existing statusline logic */ }
```

## Testing (`tests/installer.test.ts`)

All tests use a temp directory (no real `~/.claude`):

1. Install — no settings file exists → creates file with statusLine
2. Install — settings exists, no statusLine → adds statusLine
3. Install — settings has different statusLine → prompts, backs up, replaces
4. Install — already lumira → prints "already configured", no changes
5. Install — user declines prompt → no changes
6. Uninstall — backup exists → restores backup
7. Uninstall — no backup, has statusLine → removes key
8. Uninstall — no settings file → prints "nothing to uninstall"

## Scope Exclusions

- No post-install config wizard
- No theme picker
- No skill/hook installation
- No `jq` or external tool dependency
- No `lumira-install` separate bin
