# claude-cc (Claude Command Center) — Design Spec

## Overview

A TypeScript statusline plugin for Claude Code that displays real-time session metrics in the terminal. Migrated from `claude-setup/config/statusline.js` (1063 lines JS) with additional features inspired by [claude-hud](https://github.com/jarrodwatts/claude-hud).

**Superset scope:** all features from the existing JS statusline + claude-hud features (memory tracking, 3-tier color system, config-driven toggles, mtime-based transcript caching).

## Architecture

### Pipeline

Unidirectional data flow: `stdin -> parsers -> RenderContext -> render -> stdout`

```
Claude Code (~300ms interval)
        |
   stdin.ts (JSON, 250ms first-byte / 30ms idle timeout)
        |
   index.ts main() — orchestrator with DI
        |
   parsers in parallel (Promise.all)
   |- git.ts        (branch, staged, modified, untracked — 5s TTL cache)
   |- transcript.ts (tools, agents, todos, effort — mtime+size cache)
   |- token-speed.ts(output delta over 2s window)
   |- gsd.ts        (current task, update check — optional)
        |
   RenderContext (unified object)
        |
   render/index.ts — layout dispatch (custom vs minimal)
   |- line1.ts  identity
   |- line2.ts  metrics
   |- line3.ts  activity (conditional)
   |- line4.ts  GSD (conditional)
   |- minimal.ts single-line
        |
   stdout
```

### Module Structure

```
src/
  index.ts           Entry point, DI, pipeline orchestration
  stdin.ts           Timeout-based JSON parsing from stdin
  types.ts           All interfaces and type definitions
  config.ts          Config file loading + CLI flag merging
  parsers/
    git.ts           Git status with TTL file cache
    transcript.ts    JSONL transcript parser with mtime cache
    token-speed.ts   Token output speed calculation
    gsd.ts           GSD task info + update check
  render/
    index.ts         Layout mode dispatch
    icons.ts         Nerd Font icon constants
    colors.ts        3-tier color system (named, 256, truecolor)
    text.ts          displayWidth, truncate, pad, fitSegments
    line1.ts         Model | branch+git | dir -- task | worktree | agent | session | style | version
    line2.ts         Context bar | tokens | cost+burn | duration | tok/s | rate limits -- vim | effort
    line3.ts         Tools active/completed | todos progress
    line4.ts         GSD info
    minimal.ts       Single-line compact mode
  utils/
    cache.ts         Generic file cache (TTL + mtime strategies)
    exec.ts          Safe execFile with timeouts (no shell injection)
    format.ts        formatTokens, formatDuration, formatCost
    terminal.ts      Width detection, TTY, proc tree walk
```

## Types

### ClaudeCodeInput (stdin JSON)

```typescript
interface ClaudeCodeInput {
  model: string | { display_name: string };
  session_id: string;
  session_name?: string;
  cwd?: string;
  workspace?: { current_dir: string };
  context_window: {
    used_percentage: number;
    remaining_percentage: number;
    total_input_tokens?: number;
    total_output_tokens?: number;
    current_usage?: { output_tokens: number };
  };
  cost: {
    total_cost_usd: number;
    total_duration_ms: number;
    total_lines_added?: number;
    total_lines_removed?: number;
  };
  transcript_path?: string;
  output_style?: { name: string };
  version?: string;
  agent?: { name: string };
  worktree?: { name: string };
  vim?: { mode: string };
  rate_limits?: {
    five_hour?: { used_percentage: number; resets_at?: number };
    seven_day?: { used_percentage: number; resets_at?: number };
  };
  exceeds_200k_tokens?: boolean;
}
```

### Parser Outputs

```typescript
interface GitStatus {
  branch: string;
  staged: number;
  modified: number;
  untracked: number;
}

interface TranscriptData {
  tools: ToolEntry[];       // last 20
  agents: AgentEntry[];     // last 10
  todos: TodoEntry[];
  thinkingEffort: string;   // 'low' | 'medium' | 'high' | 'max' | ''
}

interface ToolEntry {
  id: string;
  name: string;
  target?: string;
  status: 'running' | 'completed' | 'error';
  startTime: number;
  endTime?: number;
}

interface AgentEntry {
  id: string;
  type: string;
  model?: string;
  description?: string;
  status: 'running' | 'completed' | 'error';
  startTime: number;
}

interface TodoEntry {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

interface GsdInfo {
  currentTask?: string;
  updateAvailable?: boolean;
}
```

### RenderContext

```typescript
interface RenderContext {
  input: ClaudeCodeInput;
  git: GitStatus;
  transcript: TranscriptData;
  tokenSpeed: number | null;
  gsd: GsdInfo | null;
  cols: number;
  config: HudConfig;
}
```

### Config

```typescript
interface HudConfig {
  layout: 'custom' | 'minimal' | 'auto';  // auto = <70 cols -> minimal
  gsd: boolean;
  display: DisplayToggles;
  colors: ColorConfig;
}

interface DisplayToggles {
  model: boolean;
  branch: boolean;
  gitChanges: boolean;
  directory: boolean;
  contextBar: boolean;
  tokens: boolean;
  cost: boolean;
  burnRate: boolean;
  duration: boolean;
  tokenSpeed: boolean;
  rateLimits: boolean;
  tools: boolean;
  todos: boolean;
  vim: boolean;
  effort: boolean;
  worktree: boolean;
  agent: boolean;
  sessionName: boolean;
  style: boolean;
  version: boolean;
  linesChanged: boolean;
  memory: boolean;
}

interface ColorConfig {
  mode: 'auto' | 'named' | '256' | 'truecolor';
}
```

## Entry Point & DI

```typescript
interface Dependencies {
  readStdin: () => Promise<ClaudeCodeInput>;
  parseGit: (cwd: string) => Promise<GitStatus>;
  parseTranscript: (path: string) => Promise<TranscriptData>;
  getTokenSpeed: (ctx: ContextWindow) => number | null;
  getGsdInfo: (session: string) => GsdInfo | null;
  getTermCols: () => number;
}

async function main(overrides: Partial<Dependencies> = {}): Promise<string> {
  const deps = { ...defaultDeps, ...overrides };
  const config = mergeCliFlags(loadConfig(), process.argv);
  const input = await deps.readStdin();
  const [git, transcript, tokenSpeed, gsd] = await Promise.all([
    deps.parseGit(input.cwd || input.workspace?.current_dir || '.'),
    input.transcript_path ? deps.parseTranscript(input.transcript_path) : emptyTranscript,
    deps.getTokenSpeed(input.context_window),
    config.gsd ? deps.getGsdInfo(input.session_id) : null,
  ]);
  const ctx: RenderContext = { input, git, transcript, tokenSpeed, gsd, cols: deps.getTermCols(), config };
  return render(ctx);
}
```

## Parsers

### git.ts
- Runs `git rev-parse --abbrev-ref HEAD` + `git status --porcelain` with 2s timeout via `utils/exec.ts`
- TTL cache: 5s, key = MD5(cwd) first 8 chars, stored in `/tmp/claude-cc-git-{hash}.json`
- Returns `GitStatus { branch, staged, modified, untracked }`
- Silent failure: returns empty GitStatus on error

### transcript.ts
- Reads JSONL line-by-line with `readline` (streaming, no full file load)
- Mtime+size cache: skips reparsing if file unchanged
- Path validation: only accepts paths within `~/.claude` or `/tmp`
- Max 50,000 lines per session
- Extracts:
  - **Tools:** `tool_use` blocks -> name, target (via `extractToolTarget`), status. Matched with `tool_result` by ID. Last 20.
  - **Agents:** `tool_use` with name `Task`/`Agent` -> type, model, description. Last 10.
  - **Todos:** from `TodoWrite` (batch), `TaskCreate` (individual), `TaskUpdate` (modify). Status normalized to `pending | in_progress | completed`.
  - **Thinking effort:** reverse regex scan for `Set model to .+ with (low|medium|high|max) effort`, fallback to `settings.json`.
- `extractToolTarget(name, input)`: Read/Write/Edit -> `file_path`, Glob -> `pattern`, Grep -> `pattern`, Bash -> command (truncated 30 chars)

### token-speed.ts
- Cache in `/tmp/claude-cc-speed.json` with 2s window
- Compares current `output_tokens` vs previous cached value
- `speed = deltaTokens / (deltaMs / 1000)` if both deltas > 0 and deltaMs <= 2000ms
- Returns `number | null`

### memory.ts
- Uses `os.totalmem()` and `os.freemem()` for memory usage
- macOS: executes `vm_stat` for accurate active/wired page counts (2s timeout)
- Returns `{ usedBytes: number; totalBytes: number; percentage: number } | null`
- Silent failure: returns null if detection fails

### gsd.ts
- Reads `~/.claude/cache/gsd-update-check.json` for update availability
- Finds most recent `{session}-agent-*.json` in `~/.claude/todos/`
- Extracts `in_progress` todo with `activeForm` field
- Path traversal validation on all file reads
- Returns `GsdInfo | null`

## Render System

### icons.ts — Nerd Font Constants

```typescript
export const ICONS = {
  model:    '\uEE0D',  // fa-robot
  branch:   '\uE725',  // dev-git-branch
  folder:   '\uF07C',  // fa-folder-open
  fire:     '\uF06D',  // fa-fire (context 65-79%)
  skull:    '\uEE15',  // fa-skull (context >=80%)
  comment:  '\uF075',  // fa-comment (tokens)
  clock:    '\uF017',  // fa-clock (duration)
  bolt:     '\uF0E7',  // fa-bolt (token speed, rate limits)
  tree:     '\uF1BB',  // fa-tree (worktree)
  cubes:    '\uF1B3',  // fa-cubes (agent)
  hammer:   '\uEEFF',  // fa-hammer (GSD task)
  warning:  '\uF071',  // fa-warning (GSD update)
  barFull:  '\u2588',  // block full
  barEmpty: '\u2591',  // block light
  ellipsis: '\u2026',  // ...
  dash:     '\u2014',  // em-dash
} as const;
```

### colors.ts — 3-Tier Color System
- **Tier 1:** Named ANSI presets (red, cyan, brightBlue, etc.) -> `\x1b[36m`
- **Tier 2:** 256-color indices (0-255) -> `\x1b[38;5;Nm`
- **Tier 3:** Truecolor hex (#rrggbb) -> `\x1b[38;2;R;G;Bm`
- Auto-detect via `COLORTERM` env var, fallback to named
- Contextual: `getContextColor(pct)` and `getQuotaColor(pct)` with threshold-based severity
- Blink support for critical states (>=80% context, >=85% rate limit)

### text.ts — Text Metrics
- `displayWidth(str)`: strips ANSI, measures chars (zero-width combiners, wide/emoji = 2, regular = 1)
- `truncField(str, max)`: truncate with ellipsis
- `truncatePath(path, max)`: smart `.../filename` truncation
- `fitSegments(left, right, sep, cols)`: progressive drop of right segments until line fits
- `padLine(left, right, cols)`: fill with spaces between left and right

### render/index.ts — Layout Dispatch
- Receives `RenderContext`
- If `config.layout === 'auto'`: cols < 70 -> minimal, else custom
- Custom: joins line1 + line2 + line3 (conditional) + line4 (conditional)
- Returns final string with `\n` separators

### line1.ts — Identity Line
- **Left:** `{model-icon} model | {branch-icon} branch {staged}{modified}{untracked} | {folder-icon} dir`
- **Right:** `+lines -lines | {active-task} | {tree} worktree | {cubes} agent | session | style | version`
- Git changes: green `+staged`, yellow `!modified`, gray `?untracked`
- Progressive truncation: 5 steps — full -> branch 24 -> branch 16 -> branch 12/dir 12 -> branch 8/dir 8
- Each segment conditional on `DisplayToggles`

### line2.ts — Metrics Line
- **Left:** `[bar] pct% | {comment} input-up output-down | $cost $burn/h | {clock} duration | {bolt} tok/s | {bolt} rate-limits`
- **Right:** `[vim-mode] | ^effort`
- Context bar: 20 segments full/empty, color by threshold (green < 50%, yellow 50-65%, orange 65-80%, blinkRed >= 80%)
- Bar icons: fire at 65-79%, skull at >= 80%
- Rate limits: only shown if >= 50%, color by threshold (yellow 50-69%, orange 70-84%, blinkRed >= 85%), countdown if >= 70%
- Vim mode and effort only if present (effort hidden if 'medium')

### line3.ts — Activity Line (conditional)
- **Tools:** checkmark + `ToolName` for completed, `ToolName(target)` for running, with count badges (`x3`)
- **Todos:** progress bar (filled/empty segments) + `completed/total` count
- Only rendered if there are tools or todos to show

### line4.ts — GSD Line (conditional)
- `{hammer} task-name | {warning} GSD update available`
- Only rendered if `config.gsd === true` and GSD data exists

### minimal.ts — Single-Line Compact Mode
- Progressive field addition by terminal width:
  - 40+ cols: `dir | branch | bar%`
  - 60+ cols: add tokens, cost, duration
  - 80+ cols: add lines changed, style, version, GSD info

## Utils

### cache.ts — Generic File Cache
Two strategies:
- **TTL-based** (git, token-speed): read if file exists and `(now - mtime) < ttlMs`, else stale
- **Mtime-based** (transcript): compare file mtime+size with cached values, skip reparse if unchanged

Cache files stored in `/tmp/claude-cc-{purpose}-{hash}.json` with `wx` flag (exclusive write, prevents symlink attacks) and `0o600` permissions. Silently ignores `EEXIST` on concurrent writes.

### exec.ts — Safe execFile
- Wrapper over `child_process.execFile` (not `exec` — avoids shell injection)
- Configurable timeout (default 2s)
- Returns stdout trimmed on success, empty string on error (never throws)
- Used by git parser and terminal width detection

### format.ts — Value Formatting
- `formatTokens(n)`: `1.2M`, `131k`, `456`
- `formatDuration(ms)`: `1h23m`, `23m45s`, `45s`
- `formatCost(usd)`: `$1.31`, `$0.0012`
- `formatBurnRate(cost, durationMs)`: `$2.24/h` (only if duration > 60s)
- Pure functions, zero dependencies

### terminal.ts — Terminal Detection
- `getTermCols()` precedence: `stdout.columns` -> `stderr.columns` -> `COLUMNS` env -> proc tree walk (5 levels via `/proc/{pid}/fd`) -> `tput cols` -> 120 default
- `getLayoutCols(rawCols, isTTY)`: if not TTY, apply 0.7 reduction factor (configurable in HudConfig)

## Config System

- File location: `~/.config/claude-cc/config.json`
- Deep merge with defaults (all display toggles default to `true`, layout `auto`, gsd `false`, colors `auto`)
- CLI flags override: `--minimal` -> `layout: 'minimal'`, `--gsd` -> `gsd: true`
- Color mode auto-detect: `COLORTERM=truecolor` -> truecolor, `TERM=xterm-256color` -> 256, else named
- Unknown keys silently ignored (forward compatibility)

## Testing

### Structure

```
tests/
  parsers/
    git.test.ts
    transcript.test.ts
    token-speed.test.ts
    gsd.test.ts
  render/
    colors.test.ts
    text.test.ts
    line1.test.ts
    line2.test.ts
    line3.test.ts
    minimal.test.ts
  utils/
    cache.test.ts
    format.test.ts
    terminal.test.ts
  config.test.ts
  stdin.test.ts
  integration.test.ts
  fixtures/
    transcript-basic.jsonl
    transcript-tools.jsonl
    transcript-todos.jsonl
    sample-input.json
```

### Approach
- **Parsers:** JSONL fixtures + mocked filesystem/exec via DI. Test pure parsing without real I/O.
- **Renderers:** fabricated `RenderContext`, explicit asserts on output string content (contains icon X, color code Y, segment Z). No snapshots.
- **Utils:** pure functions, direct input/output assertions.
- **Cache:** temp dirs with `mkdtemp()`, cleanup in `afterEach`.
- **Integration:** pipe full JSON fixture through stdin, assert stdout contains expected lines.
- **Vitest** with `@vitest/coverage-v8` for coverage reporting.

## Build & Package

### Stack
- TypeScript strict, target ES2022, ESM (NodeNext)
- Build: `tsc` -> `dist/`
- Tests: Vitest
- Zero runtime dependencies, devDependencies only: `typescript`, `@types/node`, `vitest`, `@vitest/coverage-v8`

### Integration with Claude Code
```json
// ~/.claude/settings.json
{ "statusline": "node /path/to/claude-cc/dist/index.js" }
```

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Test runner | Vitest | Superior DX, watch mode, devDep only |
| Build | tsc pure | Like claude-hud, zero bundler overhead |
| i18n | English only (v1) | Statusline is mostly icons+numbers, trivial to add later |
| Colors | 3-tier (named, 256, truecolor) | Minimal cost, max flexibility, auto-detect |
| Config | File + CLI flags | Persistent toggles + temporary overrides |
| Bridge file | Not included (v1) | No current consumers, YAGNI |
| Icons | Exact Nerd Font codepoints from existing JS | Backward compatible visual identity |
| Scope | Superset (JS features + claude-hud features) | Memory tracking, config toggles, mtime caching added |
