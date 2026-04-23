import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { hyperlink, supportsHyperlinks, resetHyperlinkSupport, _setHyperlinkSupport } from '../../src/render/hyperlink.js';
import { stripAnsi } from '../../src/render/colors.js';

describe('hyperlink', () => {
  const envKeys = ['NO_HYPERLINKS', 'FORCE_HYPERLINK', 'TERM', 'TERM_PROGRAM'] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of envKeys) saved[k] = process.env[k];
    for (const k of envKeys) delete process.env[k];
    resetHyperlinkSupport();
  });

  afterEach(() => {
    for (const k of envKeys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetHyperlinkSupport();
  });

  it('wraps text with OSC 8 sequence when supported', () => {
    _setHyperlinkSupport(true);
    const out = hyperlink('https://example.com', 'click');
    expect(out).toBe('\x1b]8;;https://example.com\x1b\\click\x1b]8;;\x1b\\');
  });

  it('returns plain text when unsupported', () => {
    _setHyperlinkSupport(false);
    expect(hyperlink('https://example.com', 'click')).toBe('click');
  });

  it('disables in Apple_Terminal (leaks markers as text)', () => {
    process.env['TERM_PROGRAM'] = 'Apple_Terminal';
    expect(supportsHyperlinks()).toBe(false);
  });

  it('disables when TERM=dumb', () => {
    process.env['TERM'] = 'dumb';
    expect(supportsHyperlinks()).toBe(false);
  });

  it('disables when NO_HYPERLINKS is set', () => {
    process.env['NO_HYPERLINKS'] = '1';
    expect(supportsHyperlinks()).toBe(false);
  });

  it('disables when FORCE_HYPERLINK=0', () => {
    process.env['FORCE_HYPERLINK'] = '0';
    expect(supportsHyperlinks()).toBe(false);
  });

  it('force-enables with FORCE_HYPERLINK=1 even in Apple_Terminal', () => {
    process.env['TERM_PROGRAM'] = 'Apple_Terminal';
    process.env['FORCE_HYPERLINK'] = '1';
    expect(supportsHyperlinks()).toBe(true);
  });

  it('defaults to enabled in modern terminals', () => {
    process.env['TERM'] = 'xterm-256color';
    expect(supportsHyperlinks()).toBe(true);
  });

  it('stripAnsi removes OSC 8 wrappers (ST terminator)', () => {
    const wrapped = hyperlink.bind(null);
    _setHyperlinkSupport(true);
    const s = wrapped('https://example.com', 'click');
    expect(stripAnsi(s)).toBe('click');
  });

  it('stripAnsi removes OSC sequences with BEL terminator too', () => {
    const bel = '\x1b]8;;https://example.com\x07text\x1b]8;;\x07';
    expect(stripAnsi(bel)).toBe('text');
  });
});
