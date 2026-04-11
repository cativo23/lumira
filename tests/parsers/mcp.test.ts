import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getMcpInfo } from '../../src/parsers/mcp.js';
import * as fs from 'node:fs';

vi.mock('node:fs');

const mockedExistsSync = vi.mocked(fs.existsSync);
const mockedReadFileSync = vi.mocked(fs.readFileSync);

beforeEach(() => { vi.resetAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('getMcpInfo', () => {
  it('returns null when no .mcp.json files exist', () => {
    mockedExistsSync.mockReturnValue(false);
    expect(getMcpInfo('/project')).toBeNull();
  });

  it('reads servers from cwd .mcp.json', () => {
    mockedExistsSync.mockImplementation((p) => String(p).includes('/project/'));
    mockedReadFileSync.mockReturnValue(JSON.stringify({
      mcpServers: { 'my-server': { command: 'node', args: ['server.js'] } },
    }));
    const result = getMcpInfo('/project');
    expect(result).not.toBeNull();
    expect(result!.servers).toHaveLength(1);
    expect(result!.servers[0].name).toBe('my-server');
    expect(result!.servers[0].status).toBe('ok');
  });

  it('deduplicates servers across files', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(JSON.stringify({
      mcpServers: { 'shared-server': { command: 'node' } },
    }));
    const result = getMcpInfo('/project');
    expect(result!.servers).toHaveLength(1);
  });

  it('handles malformed JSON gracefully', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue('not valid json');
    expect(getMcpInfo('/project')).toBeNull();
  });

  it('handles missing mcpServers key', () => {
    mockedExistsSync.mockImplementation((p) => String(p).includes('/project/'));
    mockedReadFileSync.mockReturnValue(JSON.stringify({ other: 'data' }));
    expect(getMcpInfo('/project')).toBeNull();
  });
});
