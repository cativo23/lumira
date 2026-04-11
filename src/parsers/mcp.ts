import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { McpInfo, McpServerInfo } from '../types.js';

/**
 * Read MCP server configurations from .mcp.json files.
 * Checks both cwd and ~/.claude/ for server definitions.
 */
export function getMcpInfo(cwd: string): McpInfo | null {
  const servers: McpServerInfo[] = [];

  const paths = [
    join(cwd, '.mcp.json'),
    join(homedir(), '.claude', '.mcp.json'),
  ];

  for (const p of paths) {
    if (!existsSync(p)) continue;
    try {
      const raw = JSON.parse(readFileSync(p, 'utf8'));
      const mcpServers = raw?.mcpServers ?? {};
      for (const name of Object.keys(mcpServers)) {
        // Avoid duplicates if same server in both files
        if (servers.some(s => s.name === name)) continue;
        servers.push({ name, status: 'ok' });
      }
    } catch {
      // Malformed JSON — skip
    }
  }

  if (servers.length === 0) return null;
  return { servers };
}
