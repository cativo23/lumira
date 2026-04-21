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

  it('does not write to stdout when non-TTY', async () => {
    const stdin = createMockStdin(false);
    const stdout = createMockStdout();
    await interactiveSelect({
      title: 'pick',
      options: [{ label: 'a', value: 'a' }],
      initial: 'a',
      preview: () => '',
      stdin, stdout,
    });
    expect(stdout.written).toEqual([]);
  });
});

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
    expect(out).toContain('\x1b[?25l'); // hide-cursor (written earlier)
  });
});
