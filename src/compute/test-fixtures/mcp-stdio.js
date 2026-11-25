// Test fixture: MCP stdio server against a node URL with a fake payer (fixed seed).
import { createIdentity } from '../../core/identity.js';
import { runStdio } from '../mcp.js';

const nodeUrl = process.argv[2];
const id = createIdentity(new Uint8Array(32).fill(7));
await runStdio({ nodeUrl, payer: { identityFor: () => id, balance: async () => ({ lamports: '5000000000' }) }, autopayIntervalMs: 200 });
