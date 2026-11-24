import { describe, it, expect } from 'vitest';
import { cliCommand, helpText } from '../src/index.js';

const argv = (...args: string[]) => ['node', 'lumira', ...args];

describe('helpText', () => {
  it('should_mark_the_subagent_command_as_deprecated_and_point_to_the_mod', () => {
    const line = helpText('1.0.0').split('\n').find(l => l.trimStart().startsWith('subagent'));
    expect(line).toMatch(/deprecated/i);
    expect(line).toMatch(/lumira-agentrow/);
  });
});

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
