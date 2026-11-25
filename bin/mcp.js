#!/usr/bin/env node
// MCP server (stdio) for AI agents: rent and drive a Tangent Systems agent computer.
// Same as `node bin/client.js mcp ...`; options: --coordinator <url> [--node <id>] [--data <dir>].
process.argv.splice(2, 0, 'mcp');
await import('./client.js');
