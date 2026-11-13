import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { main } from '../src/index.js';
import { EMPTY_TRANSCRIPT, DEFAULT_CONFIG, DEFAULT_DISPLAY } from '../src/types.js';
import type { HudConfig } from '../src/types.js';
import { applyPreset } from '../src/config.js';

const sample = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'sample-input.json'), 'utf8'));
const qwen = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'qwen-input.json'), 'utf8'));

function runWith(config: HudConfig, input: unknown, cols = 120) {
  const parseTranscript = vi.fn(async () => EMPTY_TRANSCRIPT);
  return main({
    readStdin: async () => input as never,
    parseGit: async () => ({ branch: 'main', staged: 0, modified: 0, untracked: 0 }),
    parseTranscript,
    getTokenSpeed: () => null,
    getMemoryInfo: () => null,
    getGsdInfo: () => null,
    getMcpInfo: () => null,
    getTermCols: () => cols,
    loadConfig: () => config,
  }).then(() => parseTranscript);
}

const base = (): HudConfig => ({ ...DEFAULT_CONFIG, display: { ...DEFAULT_DISPLAY } });
const withTranscript = { ...sample, transcript_path: '/home/u/.claude/projects/x/t.jsonl' };

describe('main transcript gating', () => {
  it('does not parse the transcript for the minimal preset', async () => {
    const cfg = base();
    applyPreset(cfg, 'minimal');
    const spy = await runWith(cfg, withTranscript);
    expect(spy).not.toHaveBeenCalled();
  });

  it('parses when singleline still shows tools', async () => {
    const cfg = base();
    applyPreset(cfg, 'minimal');
    cfg.display.tools = true;
    const spy = await runWith(cfg, withTranscript);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('parses for the multiline layout even with tools, agents and todos off', async () => {
    const cfg = base();
    cfg.layout = 'multiline';
    cfg.display.tools = false;
    cfg.display.agents = false;
    cfg.display.todos = false;
    const spy = await runWith(cfg, withTranscript);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('skips parsing on a narrow terminal that falls back to the minimal layout with line 3 widgets off', async () => {
    const cfg = base();
    cfg.layout = 'auto';
    cfg.display.tools = false;
    cfg.display.agents = false;
    cfg.display.todos = false;
    const spy = await runWith(cfg, withTranscript, 60);
    expect(spy).not.toHaveBeenCalled();
  });

  it('parses for Qwen with default display because minimal renders line 3', async () => {
    const spy = await runWith(base(), { ...qwen, transcript_path: '/home/u/.qwen/t.jsonl' });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
