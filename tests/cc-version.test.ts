import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  CC_DROPPED_SUBAGENT_STATUSLINE,
  MIN_CC_MODS,
  MOD_INSTALL_COMMAND,
  detectCcVersion,
  parseCcVersion,
  subagentPanel,
} from '../src/cc-version.js';
import { semverCompare } from '../src/utils/semver.js';

describe('parseCcVersion', () => {
  it.each([
    ['2.1.331 (Claude Code)\n', '2.1.331'],
    ['2.1.330', '2.1.330'],
    ['claude 2.1.5-beta.1', '2.1.5'],
    ['v10.0.12', '10.0.12'],
  ])('should_read_%j_as_%s', (output, expected) => {
    expect(parseCcVersion(output)).toBe(expected);
  });

  it.each(['', '   ', 'command not found', 'version two'])('should_return_undefined_for_%j', (output) => {
    expect(parseCcVersion(output)).toBeUndefined();
  });
});

describe('subagentPanel', () => {
  it.each([
    ['2.0.99', 'statusline'],
    ['2.1.0', 'statusline'],
    ['2.1.322', 'statusline'],
    ['2.1.323', 'too-old-for-mod'],
    ['2.1.325', 'too-old-for-mod'],
    ['2.1.329', 'too-old-for-mod'],
    ['2.1.330', 'mod'],
    ['2.1.331', 'mod'],
    ['2.2.0', 'mod'],
    ['10.0.0', 'mod'],
  ])('should_classify_claude_code_%s_as_%s', (version, expected) => {
    expect(subagentPanel(version)).toBe(expected);
  });

  it('should_report_unknown_when_the_version_could_not_be_read', () => {
    expect(subagentPanel(undefined)).toBe('unknown');
  });
});

describe('detectCcVersion', () => {
  it('should_parse_what_claude_version_prints', () => {
    const run = (cmd: string, args: string[]) => {
      expect(cmd).toBe('claude');
      expect(args).toEqual(['--version']);
      return '2.1.331 (Claude Code)\n';
    };
    expect(detectCcVersion(run)).toBe('2.1.331');
  });

  it('should_return_undefined_when_claude_is_not_on_the_path', () => {
    const run = () => { throw new Error('spawn claude ENOENT'); };
    expect(detectCcVersion(run)).toBeUndefined();
  });

  it('should_return_undefined_for_output_without_a_version', () => {
    expect(detectCcVersion(() => 'something else')).toBeUndefined();
  });
});

describe('constants', () => {
  it('should_keep_the_mod_minimum_in_step_with_the_mods_own_engines_gate', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../plugins/lumira-agentrow/.claude-plugin/plugin.json', import.meta.url), 'utf8'),
    );
    expect(manifest.engines['claude-code']).toBe(`>=${MIN_CC_MODS}`);
  });

  it('should_install_the_mod_the_way_the_readme_documents_it', () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    expect(readme).toContain(MOD_INSTALL_COMMAND);
  });

  it('should_have_the_mod_minimum_at_or_after_the_removal', () => {
    expect(semverCompare(CC_DROPPED_SUBAGENT_STATUSLINE, MIN_CC_MODS)).toBeLessThanOrEqual(0);
  });
});
