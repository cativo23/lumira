import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseTranscript, _clearTranscriptCache, MAX_LINES } from '../../src/parsers/transcript.js';

const ROOT = join(tmpdir(), `lumira-checkpoint-${process.pid}`);
const FIXTURES = join(import.meta.dirname, '..', 'fixtures');
const NOW = new Date('2026-05-01T12:00:00Z');

let seq = 0;
let dir: string;
let cacheDir: string;
let file: string;

function lines(name: string): string[] {
  return readFileSync(join(FIXTURES, name), 'utf8').split('\n').filter(l => l.trim());
}

async function cold(path: string) {
  _clearTranscriptCache();
  return parseTranscript(path);
}

async function warm(path: string) {
  _clearTranscriptCache();
  return parseTranscript(path, { diskCacheDir: cacheDir });
}

function checkpointFiles(): string[] {
  return existsSync(cacheDir) ? readdirSync(cacheDir).filter(f => f.endsWith('.json')) : [];
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  dir = join(ROOT, `t${++seq}`);
  cacheDir = join(dir, 'cache');
  mkdirSync(dir, { recursive: true });
  file = join(dir, 'session.jsonl');
  _clearTranscriptCache();
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe('transcript checkpoint resume', () => {
  it.each([
    'transcript-basic.jsonl',
    'transcript-agent-tool.jsonl',
    'transcript-todos.jsonl',
    'transcript-effort.jsonl',
  ])('resuming %s from every line boundary equals a cold parse', async name => {
    const all = lines(name);
    const full = join(dir, 'full.jsonl');
    writeFileSync(full, all.join('\n') + '\n');
    const expected = await cold(full);
    for (let cut = 0; cut <= all.length; cut++) {
      rmSync(cacheDir, { recursive: true, force: true });
      writeFileSync(file, all.slice(0, cut).map(l => l + '\n').join(''));
      await warm(file);
      appendFileSync(file, all.slice(cut).map(l => l + '\n').join(''));
      const resumed = await warm(file);
      expect(resumed, `cut at line ${cut}`).toEqual(expected);
    }
  });

  it('resolves a numeric TaskUpdate against todos created before the checkpoint', async () => {
    const create = (id: string, subject: string) => JSON.stringify({ timestamp: '2026-05-01T10:00:00Z', message: { content: [{ type: 'tool_use', id, name: 'TaskCreate', input: { subject } }] } });
    const update = JSON.stringify({ timestamp: '2026-05-01T10:01:00Z', message: { content: [{ type: 'tool_use', id: 'u1', name: 'TaskUpdate', input: { taskId: '2', status: 'completed' } }] } });
    writeFileSync(file, create('c1', 'one') + '\n' + create('c2', 'two') + '\n');
    await warm(file);
    appendFileSync(file, update + '\n');
    const resumed = await warm(file);
    expect(resumed.todos.map(t => t.status)).toEqual(['pending', 'completed']);
    writeFileSync(join(dir, 'full.jsonl'), create('c1', 'one') + '\n' + create('c2', 'two') + '\n' + update + '\n');
    expect(resumed).toEqual(await cold(join(dir, 'full.jsonl')));
  });

  it('keeps a tool completed when its tool_use is re-emitted after the checkpoint', async () => {
    const use = JSON.stringify({ timestamp: '2026-05-01T10:00:00Z', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } });
    const result = JSON.stringify({ timestamp: '2026-05-01T10:00:01Z', message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] } });
    writeFileSync(file, use + '\n' + result + '\n');
    await warm(file);
    appendFileSync(file, use + '\n');
    const resumed = await warm(file);
    expect(resumed.tools).toHaveLength(1);
    expect(resumed.tools[0].status).toBe('completed');
  });

  it('consumes a partial trailing line only once it is complete', async () => {
    const a = JSON.stringify({ timestamp: '2026-05-01T10:00:00Z', message: { content: [{ type: 'tool_use', id: 'a', name: 'Read', input: { file_path: '/x' } }] } });
    const b = JSON.stringify({ timestamp: '2026-05-01T10:00:02Z', message: { content: [{ type: 'tool_use', id: 'b', name: 'Edit', input: { file_path: '/y' } }] } });
    writeFileSync(file, a + '\n' + b.slice(0, 40));
    const partial = await warm(file);
    expect(partial.tools.map(t => t.id)).toEqual(['a']);
    appendFileSync(file, b.slice(40) + '\n');
    const done = await warm(file);
    expect(done.tools.map(t => t.id)).toEqual(['a', 'b']);
    expect(done.tools).toHaveLength(2);
  });

  it('does a full reparse when the file is replaced by a different shorter one', async () => {
    const all = lines('transcript-basic.jsonl');
    writeFileSync(file, all.map(l => l + '\n').join(''));
    await warm(file);
    writeFileSync(file, all.slice(0, 2).map(l => l + '\n').join(''));
    const replaced = await warm(file);
    expect(replaced).toEqual(await cold(file));
  });

  it('does a full reparse when the head of the file changed but the size grew', async () => {
    const mk = (id: string) => JSON.stringify({ timestamp: '2026-05-01T10:00:00Z', message: { content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: '/x' } }] } }) + '\n';
    writeFileSync(file, mk('aaaa'));
    await warm(file);
    writeFileSync(file, mk('bbbb') + mk('cccc'));
    const replaced = await warm(file);
    expect(replaced.tools.map(t => t.id)).toEqual(['bbbb', 'cccc']);
  });

  it('recovers from a corrupt checkpoint and rewrites it', async () => {
    const all = lines('transcript-basic.jsonl');
    writeFileSync(file, all.map(l => l + '\n').join(''));
    const first = await warm(file);
    const [cp] = checkpointFiles();
    writeFileSync(join(cacheDir, cp), '{not json');
    const second = await warm(file);
    expect(second).toEqual(first);
    expect(() => JSON.parse(readFileSync(join(cacheDir, cp), 'utf8'))).not.toThrow();
  });

  it('ignores a checkpoint whose schema version differs', async () => {
    const all = lines('transcript-basic.jsonl');
    writeFileSync(file, all.map(l => l + '\n').join(''));
    const first = await warm(file);
    const [cp] = checkpointFiles();
    const p = join(cacheDir, cp);
    const doc = JSON.parse(readFileSync(p, 'utf8'));
    doc.schema = -1;
    doc.tools = [];
    writeFileSync(p, JSON.stringify(doc));
    expect(await warm(file)).toEqual(first);
  });

  it('ignores a checkpoint that is a symlink', async () => {
    const all = lines('transcript-basic.jsonl');
    writeFileSync(file, all.map(l => l + '\n').join(''));
    const first = await warm(file);
    const [cp] = checkpointFiles();
    const p = join(cacheDir, cp);
    const decoy = join(dir, 'decoy.json');
    const doc = JSON.parse(readFileSync(p, 'utf8'));
    doc.tools = [];
    doc.agents = [];
    doc.todos = [];
    writeFileSync(decoy, JSON.stringify(doc));
    rmSync(p);
    symlinkSync(decoy, p);
    expect(await warm(file)).toEqual(first);
  });

  it.skipIf(process.platform === 'win32')('writes the checkpoint 0600 inside a 0700 directory', async () => {
    writeFileSync(file, lines('transcript-basic.jsonl').map(l => l + '\n').join(''));
    await warm(file);
    const [cp] = checkpointFiles();
    expect(statSync(join(cacheDir, cp)).mode & 0o777).toBe(0o600);
    expect(statSync(cacheDir).mode & 0o777).toBe(0o700);
  });

  it('touches no disk cache when no diskCacheDir is given', async () => {
    writeFileSync(file, lines('transcript-basic.jsonl').map(l => l + '\n').join(''));
    await cold(file);
    expect(existsSync(cacheDir)).toBe(false);
  });

  it('leaves a valid checkpoint after two parallel parses', async () => {
    writeFileSync(file, lines('transcript-basic.jsonl').map(l => l + '\n').join(''));
    _clearTranscriptCache();
    const [a, b] = await Promise.all([
      parseTranscript(file, { diskCacheDir: cacheDir }),
      parseTranscript(file, { diskCacheDir: cacheDir }),
    ]);
    expect(a).toEqual(b);
    for (const f of checkpointFiles()) expect(() => JSON.parse(readFileSync(join(cacheDir, f), 'utf8'))).not.toThrow();
    expect(await warm(file)).toEqual(a);
  });

  it('keeps the first MAX_LINES semantics when resuming across the cap', async () => {
    const mk = (i: number) => JSON.stringify({ timestamp: '2026-05-01T10:00:00Z', message: { content: [{ type: 'tool_use', id: `t${i}`, name: 'Read', input: { file_path: `/f${i}` } }] } }) + '\n';
    const first = Array.from({ length: MAX_LINES - 10 }, (_, i) => mk(i)).join('');
    const rest = Array.from({ length: 30 }, (_, i) => mk(MAX_LINES - 10 + i)).join('');
    writeFileSync(file, first);
    await warm(file);
    appendFileSync(file, rest);
    const resumed = await warm(file);
    writeFileSync(join(dir, 'full.jsonl'), first + rest);
    expect(resumed).toEqual(await cold(join(dir, 'full.jsonl')));
    expect(resumed.tools.at(-1)?.id).toBe(`t${MAX_LINES - 1}`);
  });
  it('does not re-read bytes it already consumed', async () => {
    const filler = JSON.stringify({ timestamp: '2026-05-01T10:00:00Z', message: { content: [{ type: 'text', text: 'x'.repeat(500) }] } }) + '\n';
    const target = (id: string) => JSON.stringify({ timestamp: '2026-05-01T10:00:00Z', message: { content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: '/m' } }] } }) + '\n';
    const before = filler.repeat(12);
    const after = filler.repeat(12);
    writeFileSync(file, before + target('midtool') + after);
    await warm(file);
    writeFileSync(file, before + target('MIDTOOL') + after);
    appendFileSync(file, target('newtool'));
    const resumed = await warm(file);
    expect(resumed.tools.map(t => t.id)).toEqual(['midtool', 'newtool']);
  });

  it('rejects a checkpoint with a negative offset and recovers with a full parse', async () => {
    writeFileSync(file, lines('transcript-basic.jsonl').map(l => l + '\n').join(''));
    const first = await warm(file);
    const [cp] = checkpointFiles();
    const p = join(cacheDir, cp);
    const doc = JSON.parse(readFileSync(p, 'utf8'));
    doc.offset = -5;
    writeFileSync(p, JSON.stringify(doc));
    expect(await warm(file)).toEqual(first);
    expect(JSON.parse(readFileSync(p, 'utf8')).offset).toBeGreaterThan(0);
  });

  it('sanitises and validates tool fields loaded from a tampered checkpoint', async () => {
    writeFileSync(file, lines('transcript-tools.jsonl').map(l => l + '\n').join(''));
    const first = await warm(file);
    const [cp] = checkpointFiles();
    const p = join(cacheDir, cp);
    const doc = JSON.parse(readFileSync(p, 'utf8'));
    doc.tools[0].name = 'Ba\u001b[31msh';
    doc.tools[1].target = 42;
    writeFileSync(p, JSON.stringify(doc));
    const second = await warm(file);
    expect(second).toEqual(first);
  });

  it('refuses a cache directory that is group or world writable', async () => {
    mkdirSync(cacheDir, { recursive: true, mode: 0o777 });
    chmodSync(cacheDir, 0o777);
    writeFileSync(file, lines('transcript-basic.jsonl').map(l => l + '\n').join(''));
    await warm(file);
    expect(checkpointFiles()).toEqual([]);
  });

  it('removes the temp file when the write fails and sweeps stale temp files', async () => {
    mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    const stale = join(cacheDir, 'old.json.deadbeef.tmp');
    writeFileSync(stale, 'x');
    const old = new Date(Date.now() - 2 * 3600 * 1000);
    utimesSync(stale, old, old);
    writeFileSync(file, lines('transcript-basic.jsonl').map(l => l + '\n').join(''));
    for (let i = 0; i < 22; i++) {
      const other = join(dir, `s${i}.jsonl`);
      writeFileSync(other, lines('transcript-basic.jsonl').map(l => l + '\n').join(''));
      await warm(other);
    }
    expect(existsSync(stale)).toBe(false);
    expect(readdirSync(cacheDir).filter(f => f.endsWith('.tmp'))).toEqual([]);
    expect(checkpointFiles().length).toBeLessThanOrEqual(20);
  });

  it('round-trips an unparseable timestamp the way a cold parse sees it', async () => {
    const bad = JSON.stringify({ timestamp: 'not-a-date', message: { content: [{ type: 'tool_use', id: 'x', name: 'Read', input: { file_path: '/a' } }] } }) + '\n';
    const good = JSON.stringify({ timestamp: '2026-05-01T10:00:00Z', message: { content: [{ type: 'tool_use', id: 'y', name: 'Read', input: { file_path: '/b' } }] } }) + '\n';
    writeFileSync(file, bad);
    await warm(file);
    appendFileSync(file, good);
    const resumed = await warm(file);
    writeFileSync(join(dir, 'full.jsonl'), bad + good);
    expect(resumed).toEqual(await cold(join(dir, 'full.jsonl')));
    expect(Number.isNaN(resumed.sessionStart?.getTime())).toBe(true);
  });

  it('resumes correctly across 1 MiB read chunks with multibyte text and CRLF', async () => {
    const mk = (i: number, text: string) => JSON.stringify({ timestamp: '2026-05-01T10:00:00Z', message: { content: [{ type: 'text', text }, { type: 'tool_use', id: `m${i}`, name: 'Read', input: { file_path: `/f${i}` } }] } });
    const rows: string[] = [];
    for (let i = 0; i < 40; i++) rows.push(mk(i, '日本語🙂'.repeat(8000 + (i % 7) * 311)));
    const first = rows.slice(0, 25).join('\r\n') + '\r\n';
    const rest = rows.slice(25).join('\r\n') + '\r\n';
    writeFileSync(file, first);
    expect(statSync(file).size).toBeGreaterThan(2 * 1024 * 1024);
    await warm(file);
    appendFileSync(file, rest);
    const resumed = await warm(file);
    writeFileSync(join(dir, 'full.jsonl'), first + rest);
    expect(resumed).toEqual(await cold(join(dir, 'full.jsonl')));
    expect(resumed.tools.map(t => t.id)).toEqual(Array.from({ length: 20 }, (_, i) => `m${20 + i}`));
  });

  it('keeps only a bounded window of tools in the checkpoint but still reports the latest', async () => {
    const mk = (i: number, done: boolean) => JSON.stringify({ timestamp: '2026-05-01T10:00:00Z', message: { content: [{ type: 'tool_use', id: `b${i}`, name: 'Read', input: { file_path: `/f${i}` } }, ...(done ? [{ type: 'tool_result', tool_use_id: `b${i}` }] : [])] } }) + '\n';
    let body = mk(0, false);
    for (let i = 1; i < 400; i++) body += mk(i, true);
    writeFileSync(file, body);
    await warm(file);
    const [cp] = checkpointFiles();
    const doc = JSON.parse(readFileSync(join(cacheDir, cp), 'utf8'));
    expect(doc.tools.length).toBeLessThanOrEqual(201);
    expect(doc.tools.some((t: { id: string }) => t.id === 'b0')).toBe(true);
    appendFileSync(file, mk(400, true));
    const resumed = await warm(file);
    expect(resumed.tools.at(-1)?.id).toBe('b400');
    expect(resumed.tools).toHaveLength(20);
  });
});
