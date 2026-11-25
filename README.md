# Tangent Systems

The private network layer for people and AI agents.

Tangent Systems is a network on Solana that anyone can run from their own computer. Every node on it does three jobs:

- **Private internet.** Your traffic crosses three nodes before it reaches the open web. Each one knows only the step before and the step after.
- **Off grid payments.** A signed Solana payment passes from device to device until one of them gets online.
- **Sealed computers for AI agents.** An agent rents a locked machine by the second, with a browser, a wallet and an inbox.

Payments on the network move through Helius Privacy Rings. Nodes are paid from throwaway accounts that cannot be linked back to your wallet.

Site: [tangentsystems.net](https://tangentsystems.net) · Docs: [tangentsystems.net/docs](https://tangentsystems.net/docs) · X: [@tangentsys](https://x.com/tangentsys)

## Run a node

You need a computer that stays on, Node.js 22 or newer, and an address other machines can reach with ports 9101, 9102 and 9103 open. Docker is needed only if you rent out sealed computers.

One line on an Ubuntu or Debian machine installs everything, starts the node and keeps it running:

```
curl -fsSL https://tangentsystems.net/install.sh | sudo bash
```

To be paid out, add a free [Helius](https://www.helius.dev) key in the same line. The node then registers its payout wallet with Privacy Rings by itself:

```
curl -fsSL https://tangentsystems.net/install.sh | sudo HELIUS_API_KEY=<your key> bash
```

Or by hand:

```
git clone https://github.com/tangentsystem/tangent.git
cd tangent
npm install
node bin/node.js setup
node bin/node.js --coordinator https://tangentsystems.net --host <your public address> --compute --exit --gateway
```

- `npm install` gets what the code needs. Run it once.
- `setup` gets the machine images for sealed computers. Skip it if you leave out `--compute`.
- The last line starts the node. When the log shows `node.ready`, you are part of the network.

Full guide: [Run a node](https://tangentsystems.net/docs/run-a-node)

## Get the app

Tangent for Windows and Linux puts the whole network in one window: turn the private internet on and see the three hops your traffic takes, open a private browser window, keep your wallet, rent a sealed computer, and connect your AI agent.

Tangent for Chrome switches your own browser onto the network with one click, and pauses your browsing instead of exposing it if the private internet ever drops.

Downloads: [Releases](https://github.com/tangentsystem/tangent/releases/latest) · Setup guide: [App](https://tangentsystems.net/docs/app)

Both are built from this repo by the workflow in `.github/workflows/release.yml`. To run them from source:

```
npm install
cd app
npm install
npm start
```

For the extension, open `chrome://extensions`, turn on Developer mode, choose Load unpacked and pick the `extension` folder.

## Use the network

One wallet on your machine pays for everything.

```
node bin/client.js wallet  --coordinator https://tangentsystems.net
node bin/client.js deposit --coordinator https://tangentsystems.net
node bin/client.js proxy   --coordinator https://tangentsystems.net
```

`proxy` opens a SOCKS5 proxy at `127.0.0.1:1080`. Point any app at it:

```
curl --socks5-hostname 127.0.0.1:1080 https://example.com
```

Guides: [Payments](https://tangentsystems.net/docs/payments) · [Private internet](https://tangentsystems.net/docs/private-internet) · [Off grid payments](https://tangentsystems.net/docs/off-grid)

## Give an AI agent a machine

Add this to your agent's MCP settings, with the path to the `tangent` folder:

```json
{
  "mcpServers": {
    "tangent": {
      "command": "node",
      "args": ["/path/to/tangent/bin/mcp.js", "--coordinator", "https://tangentsystems.net"]
    }
  }
}
```

The agent can then rent a machine, run commands, drive a browser, sign with the machine wallet and read its inbox.

Guide: [Sealed computers](https://tangentsystems.net/docs/agents)

## Where to look in the code

| Folder | What it does |
| --- | --- |
| `src/relay` | Onion routing: circuits, layered encryption, the three hops |
| `src/pay` | Blind signed credit, signed vouchers, deposits and withdrawals through Privacy Rings |
| `src/offgrid` | Off grid payments: bundles, durable nonces, receipts, the mesh between nodes |
| `src/compute` | Sealed computers: containers, the browser, the machine wallet, the MCP tools |
| `src/node` | The node itself: keys, credit, earnings, payouts |
| `src/coord` | The network service that nodes and clients talk to |
| `bin` | The three commands: `node.js`, `client.js`, `mcp.js` |
| `app` | The desktop app (Electron). `app/core` is everything behind the window and runs without it |
| `extension` | Tangent for Chrome |
| `web` | The site |

## Tests

```
npm test
npm run test:app
npm run test:extension
```

The tests that need Docker or a MongoDB run when those are present.
