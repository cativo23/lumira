import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, unlinkSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseTranscript } from '../../src/parsers/transcript.js';

const TMP = tmpdir();

function tmpFile(name: string): string {
  return join(TMP, `lumira-test-${name}-${process.pid}.jsonl`);
}

function toolUseLine(id: string, name: string, filePath: string, ts = '2026-04-08T10:00:00Z'): string {
  return JSON.stringify({ timestamp: ts, message: { content: [{ type: 'tool_use', id, name, input: { file_path: filePath } }] } });
}

function toolResultLine(id: string, ts = '2026-04-08T10:00:01Z'): string {
  return JSON.stringify({ timestamp: ts, message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
}

describe('incremental transcript parsing', () => {
  const files: string[] = [];
  afterEach(() => { files.forEach(f => { try { unlinkSync(f); } catch {} }); files.length = 0; });

  it('parses new lines appended since last tick without re-reading from start', async () => {
    const path = tmpFile('append');
    files.push(path);

    writeFileSync(path, toolUseLine('t1', 'Read', '/a.ts') + '\n' + toolResultLine('t1') + '\n');
    const r1 = await parseTranscript(path);
    expect(r1.tools).toHaveLength(1);
    expect(r1.tools[0].name).toBe('Read');

    // Append a second tool — incremental parse should pick it up.
    appendFileSync(path, toolUseLine('t2', 'Edit', '/b.ts', '2026-04-08T10:00:02Z') + '\n');
    const r2 = await parseTranscript(path);
    expect(r2.tools).toHaveLength(2);
    expect(r2.tools[1].name).toBe('Edit');
  });

  it('resets and full-reparses when file shrinks (truncation)', async () => {
    const path = tmpFile('shrink');
    files.push(path);

    writeFileSync(path, toolUseLine('t1', 'Read', '/a.ts') + '\n' + toolResultLine('t1') + '\n');
    await parseTranscript(path); // prime cache

    // Simulate truncation by overwriting with shorter content.
    writeFileSync(path, toolUseLine('t2', 'Bash', '/c.ts') + '\n');
    const r2 = await parseTranscript(path);
    expect(r2.tools).toHaveLength(1);
    expect(r2.tools[0].name).toBe('Bash');
  });

  it('handles partial last line (write cut mid-line) gracefully', async () => {
    const path = tmpFile('partial');
    files.push(path);

    const completeLine = toolUseLine('t1', 'Read', '/a.ts') + '\n';
    const partialLine = '{"timestamp":"2026-04-08T10:00:02Z","message":'; // incomplete JSON
    writeFileSync(path, completeLine + partialLine);

    const r = await parseTranscript(path);
    // Should parse the complete line and silently skip the partial one.
    expect(r.tools).toHaveLength(1);
    expect(r.tools[0].name).toBe('Read');
  });

  it('returns cached result when mtime and size are unchanged', async () => {
    const path = tmpFile('cache');
    files.push(path);

    writeFileSync(path, toolUseLine('t1', 'Read', '/a.ts') + '\n' + toolResultLine('t1') + '\n');
    const r1 = await parseTranscript(path);
    const r2 = await parseTranscript(path);
    // Same object reference means cache was returned.
    expect(r2).toBe(r1);
  });
});
