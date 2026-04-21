import readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';

export interface SelectOption<T> {
  label: string;
  value: T;
  description?: string;
  hint?: string;
  disabled?: boolean;
}

/**
 * Streams used by `interactiveSelect`. In production these default to
 * `process.stdin` / `process.stdout`; tests inject fakes.
 */
type SelectStdin = NodeJS.ReadStream | (Readable & {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?: (flag: boolean) => unknown;
});
type SelectStdout = NodeJS.WriteStream | (Writable & { columns?: number });

export interface SelectOpts<T> {
  title: string;
  options: SelectOption<T>[];
  initial?: T;
  preview: (focused: T) => string;
  stdin?: SelectStdin;
  stdout?: SelectStdout;
}

interface KeypressKey {
  name?: string;
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
}

const SHOW_CURSOR = '\x1b[?25h';
const HIDE_CURSOR = '\x1b[?25l';
const CLEAR_SCREEN = '\x1b[2J\x1b[H';

export async function interactiveSelect<T>(opts: SelectOpts<T>): Promise<T | null> {
  const stdin = (opts.stdin ?? process.stdin) as SelectStdin;
  const stdout = (opts.stdout ?? process.stdout) as SelectStdout;
  if (!stdin.isTTY) return null;

  const options = opts.options;
  const initialIdx = options.findIndex((o) => o.value === opts.initial);
  let focus = initialIdx >= 0 ? initialIdx : 0;

  let keypressListener: ((str: string, key: KeypressKey) => void) | null = null;

  const cleanup = () => {
    if (keypressListener) stdin.removeListener?.('keypress', keypressListener);
    if (typeof stdin.setRawMode === 'function') stdin.setRawMode(false);
    stdin.pause?.();
    stdout.write?.(SHOW_CURSOR);
  };

  const render = () => {
    stdout.write?.(CLEAR_SCREEN);
    stdout.write?.(` ${opts.title}\n\n`);
    for (let i = 0; i < options.length; i++) {
      const o = options[i];
      const marker = i === focus ? ' ❯ ' : '   ';
      const desc = o.description ? '  ' + o.description : '';
      stdout.write?.(`${marker}${o.label}${desc}\n`);
    }
    stdout.write?.('\n');
    stdout.write?.(opts.preview(options[focus].value));
    stdout.write?.('\n');
  };

  try {
    readline.emitKeypressEvents(stdin as NodeJS.ReadStream);
    if (typeof stdin.setRawMode === 'function') stdin.setRawMode(true);
    stdin.resume?.();
    stdout.write?.(HIDE_CURSOR);
    render();

    return await new Promise<T | null>((resolve) => {
      keypressListener = (_str, key) => {
        if (!key || !key.name) return;
        if (key.name === 'down' || key.name === 'j') {
          focus = (focus + 1) % options.length;
          render();
          return;
        }
        if (key.name === 'up' || key.name === 'k') {
          focus = (focus - 1 + options.length) % options.length;
          render();
          return;
        }
        if (key.name === 'return') {
          resolve(options[focus].value);
          return;
        }
      };
      stdin.on('keypress', keypressListener);
    });
  } finally {
    cleanup();
  }
}
