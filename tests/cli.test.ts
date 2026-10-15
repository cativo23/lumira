import { describe, it, expect } from 'vitest';
import { cliCommand } from '../src/index.js';

const argv = (...args: string[]) => ['node', 'lumira', ...args];

describe('cliCommand', () => {
  it.each([
    [['uninstall', '--help']],
    [['uninstall', '-h']],
    [['install', '--help']],
    [['install', 'x', '-h']],
  ])('turns %j into a help request instead of running the command', (args) => {
    expect(cliCommand(argv(...args))).toBe('--help');
  });

  it.each([
    [['install'], 'install'],
    [['uninstall'], 'uninstall'],
    [['--version'], '--version'],
    [['widget', '--help'], 'widget'],
    [[], undefined],
  ])('passes %j through as %j', (args, expected) => {
    expect(cliCommand(argv(...args))).toBe(expected);
  });
});
