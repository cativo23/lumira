/**
 * `lumira subagent` subcommand (issue #176 — `subagentStatusLine` renderer).
 *
 * Claude Code (≥ 2.1.x) lets a command customize how each subagent row renders
 * in the agent panel. CC pipes a JSON object on stdin describing every visible
 * subagent and expects ONE JSON line back per row (`{ id, content }`). Omitting
 * an id keeps CC's default rendering for that row; empty content hides it.
 *
 * Input schema (distinct from the main statusline's `RawInput`):
 *   { columns: number, tasks: [ { id, name, type, agentType, model, status,
 *                                 description, label, startTime, tokenCount, ... } ] }
 *
 * Icon choice is by STATE, not agent type. CC's `type` field is open-ended and
 * user-defined (dozens of agent types in a real setup), so there's no stable
 * type→glyph map to maintain — but `running/completed/error` map cleanly onto
 * glyphs lumira already ships across all three icon sets. The state also drives
 * the colour, so a glance tells you what's live vs done vs failed.
 *
 * Robustness contract: this runs inside CC's render loop. On ANY bad input
 * (unreadable stdin, malformed JSON, missing fields) it emits nothing and exits
 * 0 — CC then falls back to its default rows. It must never crash the panel.
 */
import { formatTokens } from '../utils/format.js';
import { displayWidth, truncField } from '../render/text.js';
import { resolveIcons, type IconSet } from '../render/icons.js';
import { createColors, detectColorMode, type Colors, type ColorMode } from '../render/colors.js';
import { loadConfig } from '../config.js';
import { sanitizeTermString } from '../normalize.js';
import { readStdin } from '../stdin.js';
import { debug } from '../utils/debug.js';
import type { Readable } from 'node:stream';
import type { SubagentInput, SubagentTask, HudConfig } from '../types.js';

export interface SubagentCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SubagentCommandOpts {
  /** stdin source — injectable for tests. Defaults to `process.stdin`. */
  stream?: Readable;
  /** Pre-loaded config — injectable for tests to avoid filesystem access. */
  config?: HudConfig;
  /** Force a colour mode — injectable for tests. */
  colorMode?: ColorMode;
}

/** Payload strings are untrusted: drop non-strings and terminal control chars. */
function clean(v: unknown): string {
  return typeof v === 'string' ? sanitizeTermString(v).trim() : '';
}

/** Per-state presentation: glyph + colour + human label. */
function styleFor(
  rawStatus: unknown,
  icons: IconSet,
  colors: Colors,
): { icon: string; color: (s: string) => string; label: string } {
  const status = clean(rawStatus);
  switch (status) {
    case 'running':
      return { icon: icons.clock, color: colors.cyan, label: 'running' };
    case 'completed':
      return { icon: icons.checkmark, color: colors.green, label: 'done' };
    case 'error':
    case 'failed':
      return { icon: icons.warning, color: colors.red, label: 'error' };
    case 'killed':
      return { icon: icons.dash, color: colors.yellow, label: 'killed' };
    default:
      // Unknown/absent state: no glyph, dim, pass the raw status through as the
      // label so a future CC state is still legible instead of being dropped.
      return { icon: '', color: colors.dim, label: status };
  }
}

/** State styling plus the plain meta (`tokens · state`) and its width. */
function rowMeta(task: SubagentTask, icons: IconSet, colors: Colors) {
  const style = styleFor(task.status, icons, colors);
  const tokens = Number.isFinite(task.tokenCount) ? `${formatTokens(task.tokenCount as number)} tok` : '';
  // Plain (uncoloured) meta used both for measuring and for assembling the
  // coloured version, so width math and output never drift apart.
  const metaPlain = [tokens, style.label].filter(Boolean);
  const metaW = metaPlain.length ? displayWidth(` · ${metaPlain.join(' · ')}`) : 0;
  return { ...style, tokens, metaW };
}

/**
 * Widths of the agent-type and model columns (0 = absent). `glyph`, when set,
 * pads every row's state glyph to the same width so the columns after it line
 * up; when unset each row keeps its own glyph width, as before columns existed.
 */
export interface SubagentColumns {
  type: number;
  model: number;
  glyph?: number;
}

const MAX_TYPE_COL = 28;
const MAX_MODEL_COL = 10;
const COL_GAP = '  ';


/** `claude-haiku-5-5` / `claude-3-5-haiku-…` → `haiku`. Anything else has no short form and is omitted. */
export function modelFamily(model: unknown): string {
  const family = /^claude-(?:\d+-)*([a-z]+)(?:-|$)/.exec(clean(model))?.[1] ?? '';
  return family.length <= MAX_MODEL_COL ? family : '';
}

/**
 * Column widths shared by every visible row, so the type and model line up the
 * way CC's own panel aligns its type column. A column no row fills is absent,
 * which keeps the output identical to pre-2.1.293 CC payloads.
 */
export function subagentColumns(tasks: SubagentTask[]): SubagentColumns {
  let type = 0;
  let model = 0;
  for (const t of tasks) {
    type = Math.max(type, displayWidth(clean(t?.agentType)));
    model = Math.max(model, displayWidth(modelFamily(t?.model)));
  }
  return { type: Math.min(type, MAX_TYPE_COL), model };
}

function padTo(s: string, width: number): string {
  return s + ' '.repeat(Math.max(0, width - displayWidth(s)));
}

/**
 * Render the `content` string for a single subagent row:
 *   `<glyph> <agent type> <model> <name> · <tokens> · <state-label>`
 *
 * The glyph and label are state-coloured; model and tokens are dim. When
 * `columns` is given the row is fitted to it: the name gives way first, then
 * the model column, then the type is shortened — the glyph and state stay.
 */
export function renderSubagentContent(
  task: SubagentTask,
  icons: IconSet,
  colors: Colors,
  columns?: number,
  cols: SubagentColumns = subagentColumns([task]),
): string {
  const { icon, color, label, tokens, metaW } = rowMeta(task, icons, colors);
  // Identity fallback. CC reports every Task subagent as the generic
  // `type: "local_agent"` with no `name`, so `description` (the dispatch arg) is
  // the only field that distinguishes rows — it must win over a generic type.
  // A meaningful `type` still wins over description, and an explicit `name`
  // wins over everything. The real agent kind (`agentType`) has its own column.
  const rawType = clean(task.type);
  const meaningfulType = rawType !== 'local_agent' ? rawType : '';
  const name = clean(task.name) || meaningfulType || clean(task.description) || clean(task.id) || 'agent';
  const agentType = clean(task.agentType);
  const model = modelFamily(task.model);

  const iconW = displayWidth(icon);
  const glyphW = Math.max(cols.glyph ?? iconW, iconW);
  const prefix = glyphW ? `${icon ? color(icon) : ''}${' '.repeat(glyphW - iconW)} ` : '';
  const prefixW = glyphW ? glyphW + 1 : 0;

  let typeW = cols.type;
  let modelW = cols.model;
  let shownName = name;
  if (columns !== undefined && columns > 0) {
    const avail = columns - prefixW - metaW;
    const colsW = () => (typeW ? typeW + COL_GAP.length : 0) + (modelW ? modelW + COL_GAP.length : 0);
    let budget = avail - colsW();
    if (budget <= 1 && modelW) {
      modelW = 0;
      budget = avail - colsW();
    }
    if (budget < displayWidth(name)) shownName = budget > 1 ? truncField(name, budget) : '';
    // With the name gone the type is the last cell: no trailing gap to reserve.
    if (!shownName && typeW) typeW = avail > 1 ? Math.min(typeW, avail) : 0;
  }

  // Trailing empty cells (a row without a type, when the name was dropped)
  // would leave padding before the meta separator.
  const cells: { text: string; width: number; paint: (s: string) => string }[] = [];
  if (typeW) cells.push({ text: truncField(agentType, typeW), width: typeW, paint: s => s });
  if (modelW) cells.push({ text: model, width: modelW, paint: colors.dim });
  if (shownName) cells.push({ text: shownName, width: 0, paint: s => s });
  while (cells.length && !cells[cells.length - 1].text) cells.pop();
  const head = cells
    .map((c, i) => {
      const text = i === cells.length - 1 ? c.text : padTo(c.text, c.width);
      return c.text ? c.paint(text) : text;
    })
    .join(COL_GAP);

  const metaColored: string[] = [];
  if (tokens) metaColored.push(colors.dim(tokens));
  if (label) metaColored.push(color(label));
  const meta = metaColored.join(' · ');

  // Avoid a dangling " · " when every head cell was truncated away.
  if (!head) return `${prefix}${meta}`.trimEnd();
  return meta ? `${prefix}${head} · ${meta}` : `${prefix}${head}`;
}

/**
 * Column layout shared by all rows. Rows differ in glyph and meta width, so
 * deciding per row whether to drop the model or shorten the type would break
 * the alignment — the decision is made once, against the tightest row.
 */
function alignColumns(rows: SubagentTask[], icons: IconSet, colors: Colors, columns?: number): SubagentColumns {
  const cols = subagentColumns(rows);
  if (!cols.type && !cols.model) return cols;
  const metas = rows.map(t => rowMeta(t, icons, colors));
  const glyph = Math.max(0, ...metas.map(m => displayWidth(m.icon)));
  let { type, model } = cols;
  if (columns !== undefined && columns > 0) {
    const glyphCell = glyph ? glyph + 1 : 0;
    const avail = Math.min(...metas.map(m => columns - glyphCell - m.metaW));
    const colsW = () => (type ? type + COL_GAP.length : 0) + (model ? model + COL_GAP.length : 0);
    if (avail - colsW() <= 1 && model) model = 0;
    if (avail - colsW() <= 1 && type) type = avail > 1 ? Math.min(type, avail) : 0;
  }
  return { type, model, glyph };
}

/**
 * Render the full CC response: one `{ id, content }` JSON line per addressable
 * task. Tasks without an id are skipped (CC keys rows by id, so a row we can't
 * address can't be overridden). Empty/missing task list → empty string.
 */
export function renderSubagentTasks(input: SubagentInput, icons: IconSet, colors: Colors): string {
  const tasks = Array.isArray(input?.tasks) ? input.tasks : [];
  const columns = Number.isFinite(input?.columns) ? (input.columns as number) : undefined;
  const rows = tasks.filter(t => t && typeof t.id === 'string' && t.id !== '');
  const cols = alignColumns(rows, icons, colors, columns);
  return rows
    .map(task => JSON.stringify({ id: task.id, content: renderSubagentContent(task, icons, colors, columns, cols) }))
    .join('\n');
}

/**
 * Wire stdin → config → render. Reuses the main `readStdin` (its only schema
 * assertion is "is a plain object", which our payload satisfies). Any failure
 * degrades to empty stdout + exit 0 so CC's panel is never broken.
 */
export async function runSubagentCommand(
  opts: SubagentCommandOpts = {},
): Promise<SubagentCommandResult> {
  const log = debug('subagent');

  let raw: unknown;
  try {
    raw = await readStdin(opts.stream ?? process.stdin);
  } catch (e) {
    log('stdin read failed:', (e as Error).message);
    return { stdout: '', stderr: '', exitCode: 0 };
  }
  if (log.enabled) log('payload:', raw);

  const config = opts.config ?? loadConfig();
  const icons = resolveIcons(config.icons);
  const mode = opts.colorMode
    ?? (config.colors?.mode && config.colors.mode !== 'auto' ? config.colors.mode : detectColorMode());
  const colors = createColors(mode);

  const out = renderSubagentTasks(raw as SubagentInput, icons, colors);
  return { stdout: out ? `${out}\n` : '', stderr: '', exitCode: 0 };
}
