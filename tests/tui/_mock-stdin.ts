import { EventEmitter } from 'node:events';

export interface MockStdin extends EventEmitter {
  isTTY: boolean;
  isRaw: boolean;
  setRawMode(flag: boolean): MockStdin;
  resume(): MockStdin;
  pause(): MockStdin;
  pressKey(name: string, opts?: { ctrl?: boolean; shift?: boolean; meta?: boolean }): void;
  emitEnd(): void;
}

export function createMockStdin(isTTY = true): MockStdin {
  const ee = new EventEmitter() as MockStdin;
  ee.isTTY = isTTY;
  ee.isRaw = false;
  ee.setRawMode = function (flag: boolean) { this.isRaw = flag; return this; };
  ee.resume = function () { return this; };
  ee.pause = function () { return this; };
  ee.pressKey = function (name: string, opts = {}) {
    const seq = name === 'return' ? '\r' : '';
    this.emit('keypress', seq, { name, ctrl: !!opts.ctrl, shift: !!opts.shift, meta: !!opts.meta });
  };
  ee.emitEnd = function () { this.emit('end'); };
  return ee;
}

export interface MockStdout extends EventEmitter {
  columns: number;
  rows: number;
  written: string[];
  write(chunk: string): boolean;
}

export function createMockStdout(columns = 100): MockStdout {
  const ee = new EventEmitter() as MockStdout;
  ee.columns = columns;
  ee.rows = 30;
  ee.written = [];
  ee.write = function (chunk: string) { this.written.push(chunk); return true; };
  return ee;
}
