import { truncField, displayWidth, safeCols } from './text.js';
import { getCustomCommandsForLine, renderCustomCommand } from './shared.js';
import type { Colors } from './colors.js';
import type { RenderContext } from '../types.js';

// Below this many cells a GSD task stops being readable — drop it instead.
const MIN_TASK_CELLS = 8;

export function renderLine4(ctx: RenderContext, c: Colors): string {
  const { gsd, icons } = ctx;
  const head: string[] = [];
  let task = '';
  let resume = '';
  const warnings: string[] = [];

  // GSD widget — only emit when GSD has something to display. Text and glyphs
  // mirror GSD's own statusline (gsd-statusline.js) so the integration reads
  // identically. The update/stale-hooks indicators render even without a
  // current task, so a GSD update is visible in any project (gated only on the
  // update-check cache, not on being inside a GSD project).
  if (gsd && (gsd.currentTask || gsd.updateAvailable || gsd.staleHooks)) {
    head.push(c.dim('GSD'));
    if (gsd.currentTask) task = gsd.currentTask;
    // Resume-point indicator (gsd-core ≥ 1.4.x). A ↩ glyph signals STATE.md has
    // an active `.continue-here`/spec resume file — a cue that work can be picked
    // up where it left off. Cyan: informational, distinct from update/stale warns.
    if (gsd.hasResume) resume = c.cyan('↩');
    if (gsd.updateAvailable) warnings.push(c.yellow('⬆ /gsd:update'));
    if (gsd.staleHooks) {
      warnings.push(gsd.devInstall
        ? c.yellow('⚠ dev install — re-run installer to sync hooks')
        : c.red('⚠ stale hooks — run /gsd:update'));
    }
  }

  // Custom commands (issue #143 phase 3) — line 4 is the lowest-priority line
  // and previously empty when GSD is absent. Custom commands declared with
  // line: 4 now surface here so users can pin their own widgets on a quiet
  // line. If neither GSD nor custom commands have content, line returns ''
  // and is omitted by the line-joiner upstream.
  const widgets: string[] = [];
  for (const out of getCustomCommandsForLine(ctx.customCommands, 4)) {
    const seg = renderCustomCommand(out, c);
    if (seg) widgets.push(seg);
  }

  // Fit order when the line is too wide: custom widgets go first (last one
  // first), then the task shrinks, then the task and the resume mark go. The
  // update and stale-hooks warnings are actionable and always stay.
  const safe = safeCols(ctx.cols);
  const build = (taskText: string, withResume: boolean, widgetCount: number) => {
    const parts = [...head];
    if (taskText) parts.push(c.bold(`${icons.hammer} ${taskText}`));
    if (withResume && resume) parts.push(resume);
    parts.push(...warnings, ...widgets.slice(0, widgetCount));
    return parts.join(' ');
  };
  const fullTask = task ? truncField(task, 60) : '';

  for (let n = widgets.length; n >= 0; n--) {
    const line = build(fullTask, true, n);
    if (displayWidth(line) <= safe) return line;
  }
  if (task) {
    const room = safe - displayWidth(build('', true, 0)) - displayWidth(`${icons.hammer} `) - 1;
    if (room >= MIN_TASK_CELLS) return build(truncField(task, room), true, 0);
  }
  const withoutTask = build('', true, 0);
  if (displayWidth(withoutTask) <= safe) return withoutTask;
  return build('', false, 0);
}
