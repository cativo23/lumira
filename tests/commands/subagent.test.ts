/**
 * Tests for `lumira subagent` subcommand (issue #176 — subagentStatusLine renderer).
 *
 * Claude Code (≥ 2.1.x) pipes every visible subagent row as JSON on stdin and
 * expects one `{ id, content }` JSON line back per row. These tests pin:
 *   - per-state rendering (icon + color + label) for running/completed/error
 *   - graceful handling of unknown states and missing fields
 *   - name fallback chain and token-segment omission
 *   - `columns` truncation of the name
 *   - the JSON-lines output contract (one line per addressable task)
 *   - the command wiring: reads stdin, never crashes CC on bad input
 *
 * Rendering assertions strip ANSI for text and separately assert glyph/colour
 * presence, so they don't couple to exact escape sequences.
 */
import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import {
  renderSubagentContent,
  renderSubagentTasks,
  modelFamily,
  runSubagentCommand,
} from '../../src/commands/subagent.js';
import { NERD_ICONS, EMOJI_ICONS, NO_ICONS } from '../../src/render/icons.js';
import { createColors, stripAnsi } from '../../src/render/colors.js';
import { displayWidth } from '../../src/render/text.js';
import type { SubagentTask, SubagentInput, HudConfig } from '../../src/types.js';

const colors = createColors('named');

function task(over: Partial<SubagentTask> = {}): SubagentTask {
  return { id: 'a1', name: 'code-reviewer', status: 'running', tokenCount: 15000, ...over };
}

describe('renderSubagentContent', () => {
  it('renders a running task: clock glyph, name, dim tokens, running label', () => {
    const out = renderSubagentContent(task(), NERD_ICONS, colors);
    const plain = stripAnsi(out);
    expect(plain).toContain('code-reviewer');
    expect(plain).toContain('15k tok');
    expect(plain).toContain('running');
    expect(out).toContain(NERD_ICONS.clock); // state glyph present
  });

  it('renders a completed task with checkmark + done label', () => {
    const out = renderSubagentContent(task({ status: 'completed' }), NERD_ICONS, colors);
    const plain = stripAnsi(out);
    expect(plain).toContain('done');
    expect(out).toContain(NERD_ICONS.checkmark);
  });

  it('renders an error task with warning glyph + error label', () => {
    const out = renderSubagentContent(task({ status: 'error' }), NERD_ICONS, colors);
    const plain = stripAnsi(out);
    expect(plain).toContain('error');
    expect(out).toContain(NERD_ICONS.warning);
  });

  it('passes an unknown status through as plain text with no glyph', () => {
    const out = renderSubagentContent(task({ status: 'queued' }), NERD_ICONS, colors);
    const plain = stripAnsi(out);
    expect(plain).toContain('queued');
    // none of the state glyphs should appear
    expect(out).not.toContain(NERD_ICONS.clock);
    expect(out).not.toContain(NERD_ICONS.checkmark);
    expect(out).not.toContain(NERD_ICONS.warning);
  });

  it('omits the token segment when tokenCount is missing', () => {
    const out = renderSubagentContent(task({ tokenCount: undefined }), NERD_ICONS, colors);
    expect(stripAnsi(out)).not.toContain('tok');
  });

  it('falls back through type then id when name is absent', () => {
    expect(stripAnsi(renderSubagentContent(task({ name: undefined, type: 'investigation' }), NERD_ICONS, colors)))
      .toContain('investigation');
    expect(stripAnsi(renderSubagentContent(task({ name: undefined, type: undefined, description: undefined, id: 'xyz' }), NERD_ICONS, colors)))
      .toContain('xyz');
  });

  it('uses description instead of the generic "local_agent" type', () => {
    // CC reports every Task subagent as type "local_agent"; the description is
    // the only field that identifies the row, so it must win over that type.
    const out = stripAnsi(renderSubagentContent(
      task({ name: undefined, type: 'local_agent', description: 'reviewing auth module' }), NERD_ICONS, colors));
    expect(out).toContain('reviewing auth module');
    expect(out).not.toContain('local_agent');
  });

  it('prefers a meaningful type (real agent_type) over description', () => {
    // If CC ever exposes the real agent type, it identifies the agent better
    // than the per-invocation description, so it wins.
    const out = stripAnsi(renderSubagentContent(
      task({ name: undefined, type: 'code-reviewer', description: 'reviewing auth module' }), NERD_ICONS, colors));
    expect(out).toContain('code-reviewer');
  });

  it('truncates the name to fit the columns budget', () => {
    const longName = 'a-really-long-subagent-name-that-overflows-the-row';
    const out = renderSubagentContent(task({ name: longName }), NO_ICONS, colors, 24);
    const plain = stripAnsi(out);
    expect(displayWidth(plain)).toBeLessThanOrEqual(24);
    expect(plain).toContain('…'); // ellipsis
  });

  it('renders tokenCount of 0 as "0 tok" (a just-started agent), not blank', () => {
    const out = renderSubagentContent(task({ tokenCount: 0 }), NO_ICONS, colors);
    expect(stripAnsi(out)).toContain('0 tok');
  });

  it('emits no leading glyph in none-icons mode for running (clock is empty)', () => {
    const out = renderSubagentContent(task(), NO_ICONS, colors);
    const plain = stripAnsi(out);
    expect(plain.startsWith('code-reviewer')).toBe(true);
  });

  it('supports emoji icon set', () => {
    const out = renderSubagentContent(task({ status: 'completed' }), EMOJI_ICONS, colors);
    expect(out).toContain(EMOJI_ICONS.checkmark);
  });

  it('renders a failed task like an error', () => {
    const out = renderSubagentContent(task({ status: 'failed' }), NERD_ICONS, colors);
    expect(stripAnsi(out)).toContain('error');
    expect(out).toContain(NERD_ICONS.warning);
  });

  it('renders a killed task as stopped, not as a failure', () => {
    const out = renderSubagentContent(task({ status: 'killed' }), NERD_ICONS, colors);
    expect(stripAnsi(out)).toContain('killed');
    expect(out).toContain(NERD_ICONS.dash);
    expect(out).not.toContain(NERD_ICONS.warning);
    expect(out).toContain(colors.yellow('killed'));
  });

  describe('agent type and model columns', () => {
    // Shape of a real CC 2.1.294 task (captured): type is always local_agent,
    // agentType carries the real kind, model is the full resolved id.
    const real = (over: Partial<SubagentTask> = {}): SubagentTask => ({
      id: 'a8818445eb7e50e79',
      type: 'local_agent',
      agentType: 'Explore',
      status: 'running',
      description: 'List render module files',
      label: 'List render module files',
      model: 'claude-haiku-5-5',
      tokenCount: 26413,
      ...over,
    });

    it('shows the agent type and model family before the description', () => {
      expect(stripAnsi(renderSubagentContent(real(), NO_ICONS, colors)))
        .toBe('Explore  haiku  List render module files · 26k tok · running');
    });

    it('dims the model family', () => {
      expect(renderSubagentContent(real(), NO_ICONS, colors)).toContain(colors.dim('haiku'));
    });

    it('omits the model when the id is not a claude-<family>-… id', () => {
      expect(stripAnsi(renderSubagentContent(real({ model: 'qwen3-coder' }), NO_ICONS, colors)))
        .toBe('Explore  List render module files · 26k tok · running');
      expect(stripAnsi(renderSubagentContent(real({ model: undefined }), NO_ICONS, colors)))
        .toBe('Explore  List render module files · 26k tok · running');
    });

    it('keeps typical custom agent names whole', () => {
      const out = stripAnsi(renderSubagentContent(
        real({ agentType: 'cccv-pr-reviewer-frontend', model: undefined }), NO_ICONS, colors));
      expect(out.startsWith('cccv-pr-reviewer-frontend  ')).toBe(true);
    });

    it('caps a long custom agent type at 28 columns', () => {
      const out = stripAnsi(renderSubagentContent(
        real({ agentType: 'an-extremely-long-custom-agent-type', model: undefined }), NO_ICONS, colors));
      const typeCell = out.split('  ')[0];
      expect(displayWidth(typeCell)).toBe(28);
      expect(typeCell.endsWith('…')).toBe(true);
    });

    it('truncates the description first, then drops the model, then shortens the type', () => {
      const row = (cols: number) => stripAnsi(renderSubagentContent(real(), NO_ICONS, colors, cols));
      // glyph-less "Explore  haiku  " = 16, meta " · 26k tok · running" = 20
      expect(row(60)).toBe('Explore  haiku  List render module files · 26k tok · running');
      expect(row(46)).toBe('Explore  haiku  List rend… · 26k tok · running');
      expect(row(37)).toBe('Explore  List re… · 26k tok · running');
      expect(row(30)).toBe('Explore · 26k tok · running');
      expect(row(25)).toBe('Expl… · 26k tok · running');
    });

    it('strips control characters from agent type, model and description', () => {
      const evil = renderSubagentContent(real({
        agentType: 'Exp\x1b[31mlore',
        model: 'claude-hai\x07ku-5-5',
        description: 'evil\x1b]8;;http://x\x07 row',
      }), NO_ICONS, colors);
      const clean = renderSubagentContent(real({
        agentType: 'Exp[31mlore',
        model: 'claude-haiku-5-5',
        description: 'evil]8;;http://x row',
      }), NO_ICONS, colors);
      expect(evil).toBe(clean);
      expect(evil).not.toContain('\x07');
    });

    it('strips control characters from an unknown status before showing it', () => {
      const out = renderSubagentContent(real({ status: 'pend\x1b[2J\x07ing' }), NO_ICONS, colors);
      expect(out).toBe(renderSubagentContent(real({ status: 'pend[2Jing' }), NO_ICONS, colors));
      expect(stripAnsi(renderSubagentContent(real({ status: { a: 1 } as unknown as string }), NO_ICONS, colors)))
        .not.toContain('object');
    });

    it('reads the family from older claude model ids too', () => {
      expect(modelFamily('claude-3-5-haiku-20241022')).toBe('haiku');
      expect(modelFamily('claude-opus-5-5')).toBe('opus');
      expect(modelFamily('claude-sonnet-4-6[1m]')).toBe('sonnet');
      expect(modelFamily('gpt-5')).toBe('');
    });

    it('ignores model ids whose family is not a short dash-delimited word', () => {
      expect(modelFamily('claude-haikuX')).toBe('');
      expect(modelFamily('claude-' + 'a'.repeat(200))).toBe('');
      expect(modelFamily('claude-opus')).toBe('opus');
    });

    it('survives non-string fields from an untrusted payload', () => {
      const bad = real({ agentType: 42 as unknown as string, model: {} as unknown as string, description: 7 as unknown as string });
      expect(stripAnsi(renderSubagentContent(bad, NO_ICONS, colors))).toBe('a8818445eb7e50e79 · 26k tok · running');
    });
  });
});

describe('renderSubagentTasks', () => {
  it('emits one JSON line per task with id + content', () => {
    const input: SubagentInput = {
      columns: 120,
      tasks: [task({ id: 'a1' }), task({ id: 'b2', status: 'completed' })],
    };
    const out = renderSubagentTasks(input, NO_ICONS, colors);
    const lines = out.split('\n');
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]);
    expect(first.id).toBe('a1');
    expect(typeof first.content).toBe('string');
    expect(JSON.parse(lines[1]).id).toBe('b2');
  });

  it('skips tasks without an id (an unaddressable row)', () => {
    const input = { tasks: [task({ id: '' }), task({ id: 'ok' })] } as SubagentInput;
    const out = renderSubagentTasks(input, NO_ICONS, colors);
    expect(out.split('\n')).toHaveLength(1);
    expect(JSON.parse(out).id).toBe('ok');
  });

  it('aligns the type and model columns across rows, like CC does', () => {
    const input: SubagentInput = {
      tasks: [
        { id: 'a', agentType: 'Explore', model: 'claude-haiku-5-5', status: 'running', description: 'Slow walk of the test suite', tokenCount: 21000 },
        { id: 'b', agentType: 'general-purpose', model: 'claude-sonnet-5-5', status: 'running', description: 'Slow walk of the source tree', tokenCount: 43000 },
      ],
    };
    const rows = renderSubagentTasks(input, NO_ICONS, colors).split('\n').map(l => stripAnsi(JSON.parse(l).content));
    expect(rows).toEqual([
      'Explore          haiku   Slow walk of the test suite · 21k tok · running',
      'general-purpose  sonnet  Slow walk of the source tree · 43k tok · running',
    ]);
  });

  it('keeps the column aligned for a row that has no agent type', () => {
    const input: SubagentInput = {
      tasks: [
        { id: 'a', agentType: 'Explore', status: 'running', description: 'one', tokenCount: 1000 },
        { id: 'b', status: 'running', description: 'two', tokenCount: 1000 },
      ],
    };
    const rows = renderSubagentTasks(input, NO_ICONS, colors).split('\n').map(l => stripAnsi(JSON.parse(l).content));
    expect(rows).toEqual([
      'Explore  one · 1k tok · running',
      '         two · 1k tok · running',
    ]);
  });

  it('renders byte-identical to v1.19.0 when CC sends no agent type or model (CC < 2.1.293)', () => {
    // Expected strings captured from a build of main before this feature.
    const I = NERD_ICONS;
    const input: SubagentInput = {
      columns: 40,
      tasks: [
        { id: 'a', status: 'running', description: 'reviewing the auth module carefully', tokenCount: 126000 },
        { id: 'b', status: 'completed', description: 'exploring', tokenCount: 1000 },
        { id: 'c', status: 'failed', name: 'code-reviewer' },
      ],
    };
    const rows = renderSubagentTasks(input, I, colors).split('\n').map(l => JSON.parse(l).content);
    expect(rows).toEqual([
      `\x1b[36m${I.clock}\x1b[0m reviewing the au… · \x1b[2m126k tok\x1b[0m · \x1b[36mrunning\x1b[0m`,
      `\x1b[32m${I.checkmark}\x1b[0m exploring · \x1b[2m1k tok\x1b[0m · \x1b[32mdone\x1b[0m`,
      `\x1b[31m${I.warning}\x1b[0m code-reviewer · \x1b[31merror\x1b[0m`,
    ]);
  });

  it('aligns the columns when state glyphs have different widths', () => {
    // none icons: running has no glyph, done is ✓ and killed is —.
    const input: SubagentInput = {
      tasks: [
        { id: 'a', agentType: 'Explore', status: 'running', description: 'one' },
        { id: 'b', agentType: 'Explore', status: 'completed', description: 'two' },
        { id: 'c', agentType: 'Explore', status: 'pending', description: 'three' },
      ],
    };
    const render = (icons: typeof NO_ICONS) =>
      renderSubagentTasks(input, icons, colors).split('\n').map(l => stripAnsi(JSON.parse(l).content));
    // ✓ is a one-cell glyph in terminals even though displayWidth counts it as two.
    expect(render(NO_ICONS)).toEqual([
      '  Explore  one · running',
      '✓ Explore  two · done',
      '  Explore  three · pending',
    ]);
    expect(render(NERD_ICONS)).toEqual([
      `${NERD_ICONS.clock} Explore  one · running`,
      '✓ Explore  two · done',
      '  Explore  three · pending',
    ]);
    expect(render(EMOJI_ICONS)).toEqual([
      `${EMOJI_ICONS.clock} Explore  one · running`,
      `${EMOJI_ICONS.checkmark} Explore  two · done`,
      '   Explore  three · pending',
    ]);
  });

  it('keeps the columns aligned on narrow rows whose meta differs in width', () => {
    const input: SubagentInput = {
      columns: 40,
      tasks: [
        { id: 'a', agentType: 'Explore', model: 'claude-haiku-5-5', status: 'running', description: 'List render module files', tokenCount: 126000 },
        { id: 'b', agentType: 'Explore', model: 'claude-haiku-5-5', status: 'completed', description: 'List render module files', tokenCount: 1000 },
      ],
    };
    const rows = renderSubagentTasks(input, NERD_ICONS, colors).split('\n').map(l => stripAnsi(JSON.parse(l).content));
    expect(rows).toEqual([
      `${NERD_ICONS.clock} Explore  List re… · 126k tok · running`,
      '✓ Explore  List render … · 1k tok · done',
    ]);
  });

  it('returns an empty string for an empty or missing task list', () => {
    expect(renderSubagentTasks({ tasks: [] }, NO_ICONS, colors)).toBe('');
    expect(renderSubagentTasks({} as SubagentInput, NO_ICONS, colors)).toBe('');
  });
});

describe('runSubagentCommand', () => {
  const cfg: HudConfig = { icons: 'none', colors: { mode: 'named' } } as HudConfig;

  function streamOf(json: string): Readable {
    return Readable.from([json]);
  }

  it('reads stdin and prints one JSON line per task, exit 0', async () => {
    const payload = JSON.stringify({ columns: 100, tasks: [task({ id: 'z9' })] });
    const r = await runSubagentCommand({
      stream: streamOf(payload),
      config: cfg,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
    const line = r.stdout.trim();
    expect(JSON.parse(line).id).toBe('z9');
  });

  it('never crashes CC on malformed stdin — empty stdout, exit 0', async () => {
    const r = await runSubagentCommand({
      stream: streamOf('not json at all'),
      config: cfg,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('emits nothing when there are no tasks', async () => {
    const r = await runSubagentCommand({
      stream: streamOf(JSON.stringify({ columns: 80, tasks: [] })),
      config: cfg,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('');
  });
});
