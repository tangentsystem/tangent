// Page definitions for the Tangent Systems site.
//
// Two kinds of page share one 3D network (web/tangent.js):
//   JOURNEYS  scroll journeys (/, /nodes, /agents). `seq` picks which stops of the
//             journey the page visits (0 the word, 1 the first node, 2 the private
//             route, 3 off grid, 4 the agent computer, 5 the whole network).
//   DOCS      reading pages (/docs and its guides). Every section carries `k`, the
//             stop of the scene it belongs to (fractions travel between stops), and
//             the camera follows the reader's scroll through those stops.
//
// Copy in blocks is plain text with two marks: `code` and [link text](url).
// Block kinds: ['p', text] ['code', text] ['list', [text...]] ['opts', [[term, text]...]] ['h3', text, k]

export const X_URL = 'https://x.com/tangentsys';
export const REPO_URL = 'https://github.com/tangentsystem/tangent';
export const SITE_URL = 'https://tangentsystems.net';
const C = SITE_URL; // the network address the tools talk to (same app as this site)

const line = (a, b) => ({ d: [[a, 0], [b, 1]] });

export const PAGES = [
  {
    path: '/',
    nav: null,
    title: 'Tangent Systems',
    word: 'TANGENT',
    hero: 'A private network, run by people.',
    seq: [0, 1, 2, 3, 4, 5],
    say: {
      1: { ...line('It starts with one node.', 'Then they find each other.'), m: [['It starts with', 0], ['one node.', 0], ['Then they find', 1], ['each other.', 1]] },
      2: { ...line('Three hops.', 'Nobody sees the whole trip.'), m: [['Three hops.', 0], ['Nobody sees', 1], ['the whole trip.', 1]] },
      3: { ...line('No internet.', 'The payment still lands.'), m: [['No internet.', 0], ['The payment', 1], ['still lands.', 1]] },
      4: { ...line('A sealed computer,', 'rented by an AI agent.'), m: [['A sealed', 0], ['computer,', 0], ['rented by an', 1], ['AI agent.', 1]] },
      5: { ...line('Run a node.', 'Be part of the network.'), m: [['Run a node.', 0], ['Be part of', 1], ['the network.', 1]] },
    },
    sub: {
      1: 'Every node that joins links to the ones near it. There is no center and nothing to switch off.',
      2: 'Your traffic crosses three nodes before it reaches the open web. Each one knows only the step before and the step after.',
      3: 'A signed Solana payment passes from device to device until one of them gets online.',
      4: 'It comes with a browser, a wallet and an inbox. Nothing gets in or out except through the network.',
    },
    actions: [['Run a node', '/docs/run-a-node', 'btn'], ['Read the docs', '/docs', 'txt']],
  },
  {
    path: '/nodes',
    nav: 'Nodes',
    title: 'Nodes · Tangent Systems',
    word: 'NODES',
    hero: 'One machine. Three jobs.',
    seq: [0, 1, 2, 3, 4, 5],
    say: {
      1: { ...line('Any machine can be a node.', 'Yours links to the ones near it.'), m: [['Any machine', 0], ['can be a node.', 0], ['Yours links to', 1], ['the ones near it.', 1]] },
      2: { ...line('It carries private traffic.', 'One hop out of three.'), m: [['It carries', 0], ['private traffic.', 0], ['One hop', 1], ['out of three.', 1]] },
      3: { ...line('It passes payments along.', 'And shares the tip.'), m: [['It passes', 0], ['payments along.', 0], ['And shares', 1], ['the tip.', 1]] },
      4: { ...line('It rents out sealed computers.', 'Paid for every second.'), m: [['It rents out', 0], ['sealed computers.', 0], ['Paid for', 1], ['every second.', 1]] },
      5: { ...line('Start yours.', 'Three commands.'), m: [['Start yours.', 0], ['Three commands.', 1]] },
    },
    sub: {
      1: 'A laptop, a desktop or a rented box. It joins the network and finds its neighbours.',
      2: 'Your node never sees who is asking and where they are going at the same time. It earns for every megabyte it carries.',
      3: 'When a payment travels without internet, every node that carries it earns part of the tip.',
      4: 'AI agents rent a locked machine on your node. Their browser, wallet and files stay inside it.',
    },
    lab: { you: 'a user', 'the first node': 'your node' },
    cmd: { 5: `npm install\nnode bin/node.js setup\nnode bin/node.js --coordinator ${C} --host <your public address> --compute` },
    actions: [['Full guide', '/docs/run-a-node', 'btn'], ['All docs', '/docs', 'txt']],
  },
  {
    path: '/agents',
    nav: 'Agents',
    title: 'Agents · Tangent Systems',
    word: 'AGENTS',
    hero: 'Computers that AI agents rent by the second.',
    seq: [0, 2, 4, 5],
    say: {
      2: { ...line('Every request takes three hops.', 'Nobody sees the whole trip.'), m: [['Every request', 0], ['takes three hops.', 0], ['Nobody sees', 1], ['the whole trip.', 1]] },
      4: { ...line('A sealed computer,', 'gone when the job is done.'), m: [['A sealed', 0], ['computer,', 0], ['gone when the', 1], ['job is done.', 1]] },
      5: { ...line('Give your agent a machine.', 'One tool in its list.'), m: [['Give your agent', 0], ['a machine.', 0], ['One tool', 1], ['in its list.', 1]] },
    },
    sub: {
      2: 'What an agent browses leaves through the private network, so the sites it visits never learn where it runs.',
      4: 'It comes with a browser, a wallet and an inbox. Nothing gets in or out except through the network.',
    },
    lab: { you: 'the agent' },
    cmd: { 5: `node bin/mcp.js --coordinator ${C}` },
    actions: [['Agent guide', '/docs/agents', 'btn'], ['All docs', '/docs', 'txt']],
  },
];

// ---- docs

const BASE = 'the folder of the Tangent Systems code';

export const GUIDES = [
  {
    path: '/docs/run-a-node',
    nav: 'Run a node',
    blurb: 'Join the network and earn from three jobs.',
    title: 'Run a node · Tangent Systems',
    h1: 'Run a node',
    lede: 'Your machine joins the network, does three jobs and earns for each one.',
    k: 5,
    lab: { 'the first node': 'your node', you: 'a user' },
    sections: [
      { id: 'what-you-need', h: 'What you need', k: 5, blocks: [
        ['list', [
          'A computer that stays on. A desktop, a laptop or a rented machine all work.',
          'Node.js 22 or newer.',
          'Docker, if you want to rent out sealed computers to AI agents.',
          'An address other machines can reach: a public IP or host name, with ports 9101, 9102 and 9103 open.',
        ]],
      ] },
      { id: 'install', h: 'Install', k: 1, blocks: [
        ['p', `The code is on [GitHub](${REPO_URL}). Get it, open its folder and install it.`],
        ['code', `git clone ${REPO_URL}.git\ncd tangent\nnpm install`],
        ['p', 'If you will rent out computers, start Docker and get the machine images once. It builds the browser image and pulls the rest, so the first run takes a few minutes.'],
        ['code', 'node bin/node.js setup'],
      ] },
      { id: 'start', h: 'Start', k: 1.15, blocks: [
        ['code', `node bin/node.js --coordinator ${C} --host <your public address>`],
        ['p', '`--coordinator` tells the node where the network lives. `--host` is the address other nodes and users reach you at.'],
        ['p', 'Turn on the jobs you want:'],
        ['code', `node bin/node.js --coordinator ${C} --host <your public address> \\\n  --compute --exit --gateway`],
        ['opts', [
          ['--compute', 'Rent out sealed computers to AI agents. Needs Docker.'],
          ['--exit', 'Be the last hop, the one that opens connections to the open web.'],
          ['--gateway', 'Put off grid payments on chain. Needs a Solana RPC: set `HELIUS_API_KEY` or pass `--rpc-url`.'],
          ['--peer host:port', 'Link to a nearby node for off grid payments. Repeat it for more.'],
          ['--region eu-west', 'A rough region to show on the map.'],
        ]],
        ['p', 'When the log shows `node.ready`, you are part of the network. The `node.identity` line holds your node id.'],
      ] },
      { id: 'three-jobs', h: 'The three jobs', k: 1.4, blocks: [
        ['h3', 'Private internet', 2],
        ['p', 'Every node carries private traffic. Data crosses three nodes on its way out and each one sees only the step before and the step after. With `--exit` your node can be the last step. It earns for every megabyte it carries.'],
        ['h3', 'Off grid payments', 3],
        ['p', 'Your node passes signed payments to its peers until one of them gets online. With `--gateway` it is the one that puts them on chain. The gateway and every node that carried a payment share its tip.'],
        ['h3', 'Sealed computers', 4],
        ['p', 'With `--compute`, AI agents rent locked machines on your node, paid for every second. Each one runs in its own Docker container and reaches the web only through three other nodes.'],
        ['p', 'That traffic is paid from your node\'s own wallet, shown in the `egress.ready` log line. Deposit to it like any wallet (see [Payments](/docs/payments)); without credit, machine traffic stops after a small free amount.'],
      ] },
      { id: 'earnings', h: 'Earnings and payouts', k: 4.6, blocks: [
        ['p', 'Users pay your node with signed vouchers as they go. Your node cashes the newest one for each session, so it is paid for exactly what was used. Off grid tips are claimed the moment a payment lands.'],
        ['p', 'See what your node has earned, what is waiting and what was paid:'],
        ['code', `curl ${C}/api/nodes/<your node id>/earnings`],
        ['p', 'Payouts go out in batches through Helius Privacy Rings once unpaid earnings pass 0.01 SOL.'],
        ['p', 'Where they go:'],
        ['list', [
          'Leave out `--payout` and the node makes its own payout wallet. With `HELIUS_API_KEY` set it registers that wallet with Privacy Rings by itself. The log line `payout.fund_this_wallet` shows the address and how much SOL it needs for that first.',
          'Or pass `--payout <address>` with your own Privacy Rings wallet that is already registered.',
        ]],
      ] },
      { id: 'keep-it-running', h: 'Keep it running', k: 5, blocks: [
        ['list', [
          'Stop it with Ctrl+C. It finishes cleanly.',
          'Start it again with the same command. It keeps its identity and keys and rejoins the network by itself.',
          'Use whatever starts programs at boot on your machine, such as a systemd service, so it comes back after a restart.',
          'If the network cannot be reached for a while, the node keeps the vouchers it holds and tries again every few seconds.',
        ]],
      ] },
      { id: 'keys-and-backups', h: 'Keys and backups', k: 5, blocks: [
        ['p', 'Everything lives in one data folder: `~/.tangent/node`, or the folder you pass with `--data`.'],
        ['opts', [
          ['keys/', 'Your node identity, its payout wallet and the other keys.'],
          ['backups/', 'A copy of every key, written before the key itself.'],
          ['backups/machine-wallets/', 'Wallet keys of rented computers, encrypted.'],
          ['offgrid/', 'Payments your node is carrying.'],
          ['credit/', 'Credit being bought. It holds real value.'],
        ]],
        ['p', 'Keys are made once and never overwritten. If a saved key is damaged, the node stops rather than make a new one. Copy the whole folder somewhere safe.'],
        ['p', 'Rented computer wallets: your node keeps each key, encrypted, for 30 days after the computer ends so its renter can get it back. Then it deletes that key.'],
      ] },
    ],
  },
  {
    path: '/docs/payments',
    nav: 'Payments',
    blurb: 'One wallet on your machine pays for everything, privately.',
    title: 'Payments · Tangent Systems',
    h1: 'Payments',
    lede: 'One wallet on your machine pays for everything. Nodes never see it.',
    k: 1,
    lab: { 'the first node': 'your wallet' },
    sections: [
      { id: 'how-it-works', h: 'How it works', k: 1, blocks: [
        ['p', 'The client tool keeps one wallet on your machine. You fill it with SOL through Helius Privacy Rings. When you use the network, part of that balance becomes credit: a fresh throwaway account for each node you use. Nodes only ever see those accounts.'],
        ['p', 'Credit is signed blind, so nobody can link a throwaway account back to your wallet.'],
      ] },
      { id: 'wallet', h: 'Your wallet', k: 1.05, blocks: [
        ['code', `node bin/client.js wallet --coordinator ${C}`],
        ['p', 'The first run makes the wallet and prints its address. It lives in `~/.tangent/client`, or the folder you pass with `--data`. Keep that folder safe: the keys in it hold your money.'],
        ['p', 'Set `TANGENT_COORDINATOR` once and you can leave out `--coordinator`:'],
        ['code', `export TANGENT_COORDINATOR=${C}`],
      ] },
      { id: 'deposit', h: 'Deposit', k: 1.12, blocks: [
        ['code', `node bin/client.js deposit --coordinator ${C}`],
        ['p', 'It shows the network\'s Privacy Rings wallet and a memo made for your wallet. Send SOL through Privacy Rings to that wallet with that memo and it is added to your balance.'],
      ] },
      { id: 'balance', h: 'Balance', k: 1.2, blocks: [
        ['code', `node bin/client.js balance --coordinator ${C}`],
        ['p', 'It shows your wallet balance, your credit in total and each throwaway account with the node it pays. `current` marks the account a node is paid from now. Amounts are in lamports: 1 SOL is 1,000,000,000 lamports.'],
      ] },
      { id: 'credit', h: 'Credit', k: 1.26, blocks: [
        ['p', 'The private internet, rented computers and the agent tools buy credit by themselves the first time they use a node. Each node gets one token. To start with more, buy it before first use:'],
        ['code', `node bin/client.js credit --coordinator ${C} --tokens 5`],
        ['p', '`--tokens` is how many tokens each node gets. `--nodes` takes node ids, comma separated; leave it out for every live node. A token is worth the smallest amount the network issues, 0.001 SOL.'],
      ] },
      { id: 'top-up', h: 'Top up', k: 1.28, blocks: [
        ['p', 'Add more for the nodes you already use:'],
        ['code', `node bin/client.js credit --coordinator ${C} --top-up --tokens 5`],
        ['p', 'Each of those nodes gets a fresh throwaway account holding the new tokens and is paid from it from then on. Nothing ties the new account to the old one.'],
        ['p', 'Add `--same-account` to put the tokens on the account the node already has. One account that keeps receiving tokens gives more chances to match it to your wallet by when you bought them, so a fresh account is the default.'],
        ['h3', 'Automatic top up', 1.29],
        ['p', 'The private internet, rented computers and the agent tools also top up on their own when a node\'s credit runs low, one token at a time (`--tokens` sets more). They spend at most 0.01 SOL that way in any 24 hours, counted across every run from the same data folder. Set your own limit in lamports, or `0` to turn it off:'],
        ['code', `node bin/client.js proxy --coordinator ${C} --top-up-limit 50000000`],
        ['p', 'A rented computer stays with the account that rented it, so while it runs its credit is topped up on that same account.'],
      ] },
      { id: 'withdraw', h: 'Withdraw', k: 1.32, blocks: [
        ['p', 'Unused wallet balance can go back out through Privacy Rings, to your own Privacy Rings wallet or to a public address. Give the address and the amount in lamports. The smallest withdrawal is 0.001 SOL.'],
        ['code', `node bin/client.js withdraw --coordinator ${C} --to <address> --lamports 100000000`],
        ['p', 'Add `--public` to send to a plain public address. Your wallet signs the request, then the tool waits until the money has left and prints `sent` with a Solscan link. If it cannot be sent, the amount goes back to your balance and it prints `refunded`.'],
        ['p', 'If it is still on its way after two minutes, it prints the withdrawal id. Follow it with:'],
        ['code', `node bin/client.js withdraw --coordinator ${C} --id <withdrawal id>`],
      ] },
    ],
  },
  {
    path: '/docs/private-internet',
    nav: 'Private internet',
    blurb: 'Browse through three hops from any app.',
    title: 'Private internet · Tangent Systems',
    h1: 'Private internet',
    lede: 'A proxy on your own machine. Everything you send through it takes three hops.',
    k: 2,
    lab: { you: 'you' },
    sections: [
      { id: 'start', h: 'Start the proxy', k: 2, blocks: [
        ['code', `node bin/client.js proxy --coordinator ${C}`],
        ['p', 'It buys a little credit for each node, then opens a proxy at `127.0.0.1` port `1080`. When it prints `socks.ready`, it is ready. Leave it running.'],
        ['p', 'The first node knows you but not where you are going. The last one knows where you are going but not who you are. The one in the middle knows neither.'],
        ['opts', [
          ['--socks-port 1081', 'Use another local port.'],
          ['--hops 4', 'Take more hops, up to 5.'],
          ['--tokens 5', 'Tokens each node gets, the first time and on every top up.'],
          ['--top-up-limit 50000000', 'Most it spends on top ups in any 24 hours, in lamports. Default 0.01 SOL; `0` turns it off.'],
          ['--same-account', 'Top up the account a node already has instead of a fresh one.'],
        ]],
      ] },
      { id: 'point-an-app', h: 'Point an app at it', k: 2, blocks: [
        ['p', 'Any app that supports a SOCKS5 proxy can use it. Let the proxy look up names too, so your lookups stay private.'],
        ['p', 'Test it in a terminal:'],
        ['code', 'curl --socks5-hostname 127.0.0.1:1080 https://example.com'],
        ['p', 'Firefox: open Settings, then Network Settings, and choose Manual proxy configuration. Set SOCKS Host to `127.0.0.1`, Port to `1080`, pick SOCKS v5 and tick Proxy DNS when using SOCKS v5.'],
        ['p', 'Chrome or Chromium: start it with the proxy.'],
        ['code', 'google-chrome --proxy-server="socks5://127.0.0.1:1080"'],
      ] },
      { id: 'credit', h: 'Add credit', k: 2.1, blocks: [
        ['p', 'You need balance in your wallet first (see [Payments](/docs/payments)). The proxy gives each node one token the first time it uses that node, and checks for new nodes every minute.'],
        ['p', 'When a node\'s credit runs low, the proxy buys it another token on a fresh throwaway account, within your 24 hour limit. New connections use the new account; the ones already open finish on the old one.'],
        ['p', 'For long sessions, give every node more before you start the proxy:'],
        ['code', `node bin/client.js credit --coordinator ${C} --top-up --tokens 5`],
      ] },
      { id: 'balance', h: 'Check your balance', k: 2.2, blocks: [
        ['code', `node bin/client.js balance --coordinator ${C}`],
        ['p', 'It lists what is left on each node\'s account and in your wallet. When an account runs dry and your top up limit is used, that node holds your traffic until it is paid; a top up or a new connection gets it moving.'],
      ] },
    ],
  },
  {
    path: '/docs/off-grid',
    nav: 'Off grid',
    blurb: 'Send a payment with no internet.',
    title: 'Off grid · Tangent Systems',
    h1: 'Off grid payments',
    lede: 'Your payment is passed from device to device until one of them gets online.',
    k: 3,
    sections: [
      { id: 'what-you-need', h: 'What you need', k: 3, blocks: [
        ['list', [
          'A Solana keypair file with SOL in it. This is the wallet you pay from.',
          'A durable nonce account for that wallet, so the payment does not expire on the way. You make it once, while online.',
          'The off grid address of a node near you, as host and port (port 9103 unless its owner changed it). Your device reaches it over a local link such as the same WiFi. No internet needed.',
        ]],
      ] },
      { id: 'before', h: 'Before you go offline', k: 3.02, blocks: [
        ['p', 'With the Solana command line tools, make the nonce account and read its value:'],
        ['code', 'solana-keygen new -o nonce.json\nsolana create-nonce-account nonce.json 0.0015 --keypair wallet.json\nsolana address -k nonce.json\nsolana nonce nonce.json'],
        ['p', 'Keep the nonce account address and the nonce value. To tip the nodes that carry your payment, also keep the network tip account, `network.tipAccount` here:'],
        ['code', `curl ${C}/api/health`],
      ] },
      { id: 'send', h: 'Send', k: 3.05, blocks: [
        ['code', `node bin/client.js offgrid-send --coordinator ${C} \\\n  --peer 192.168.1.20:9103 --keypair wallet.json \\\n  --nonce-account <nonce account> --nonce-value <nonce value> \\\n  --to <recipient address> --lamports 50000000 \\\n  --tip 60000 --tip-account <tip account>`],
        ['p', '`--lamports` is the amount: 1 SOL is 1,000,000,000 lamports. `--tip` is what the carrying nodes share. Leave both tip options out to send without a tip.'],
      ] },
      { id: 'what-happens', h: 'What happens to it', k: 3.08, blocks: [
        ['list', [
          'The tool signs the payment on your device and hands it to the node.',
          'Nodes pass it along, piece by piece, until one with internet puts it on chain.',
          'That node sends a signed receipt back the way the payment came.',
          'The node that put it on chain and the ones that carried it share your tip.',
        ]],
      ] },
      { id: 'landed', h: 'How to know it landed', k: 3.14, blocks: [
        ['p', 'The tool waits up to 120 seconds for the receipt. Change that with `--timeout-sec`. When the receipt comes, it prints it with a Solscan link to the payment.'],
        ['p', 'If the receipt does not come in time, the tool stops waiting but your payment stays with the nodes and keeps travelling for up to three days. Look up the recipient on Solscan once you are back online.'],
      ] },
      { id: 'tips', h: 'Tips', k: 3.2, blocks: [
        ['list', [
          'Each payment uses up the nonce value. Read the new one with `solana nonce nonce.json` before the next payment, or make a few nonce accounts ahead of time.',
          'With no internet the tool cannot look up the tip account, so always pass `--tip-account` when you tip.',
          'The more nodes around you, the faster it finds a way out.',
        ]],
      ] },
    ],
  },
  {
    path: '/docs/agents',
    nav: 'Agents',
    blurb: 'Rent sealed computers, for you or for your AI agent.',
    title: 'Agents · Docs · Tangent Systems',
    h1: 'Sealed computers',
    lede: 'Rent a locked machine by the second, for yourself or for your AI agent.',
    k: 4,
    sections: [
      { id: 'rent', h: 'Rent one yourself', k: 4, blocks: [
        ['code', `node bin/client.js rent --coordinator ${C} --cmd "uname -a" --cmd "ls /work"`],
        ['p', 'It picks a live node that rents computers, buys credit for it, starts a sealed machine, runs each `--cmd` in turn and stops it. It prints the results, the machine id, the machine\'s wallet and the bill. Keep the machine id.'],
        ['opts', [
          ['--node <id>', 'Rent on this node.'],
          ['--image', '`browser` (the default when the node has it), `alpine`, `node` or `python`.'],
          ['--size', '`small`, `medium` or `large`.'],
          ['--hold-seconds 60', 'Keep it running this long before it stops.'],
        ]],
        ['p', 'See the nodes that rent computers:'],
        ['code', `curl "${C}/api/directory?role=compute"`],
      ] },
      { id: 'mcp', h: 'Give an AI agent the tools', k: 4.02, blocks: [
        ['p', 'With the MCP tools an agent rents and drives machines by itself, paid from your wallet. Add this to your agent\'s MCP settings, with the path to your Tangent Systems folder:'],
        ['code', `{
  "mcpServers": {
    "tangent": {
      "command": "node",
      "args": ["/path/to/tangent/bin/mcp.js", "--coordinator", "${C}"]
    }
  }
}`],
        ['p', 'Or run the tools over HTTP on your own machine and connect the agent to `http://127.0.0.1:8787/mcp`:'],
        ['code', `node bin/client.js mcp --coordinator ${C} --http 8787`],
        ['p', 'The tools the agent gets:'],
        ['opts', [
          ['rent_computer', 'Rent a machine. Picks image and size.'],
          ['exec', 'Run a shell command. Returns the exit code and output.'],
          ['write_file, read_file', 'Files in `/work` and `/tmp`.'],
          ['browser_open, browser_read', 'Open a page and read its text.'],
          ['browser_click, browser_type', 'Click and type by CSS selector.'],
          ['browser_screenshot', 'A picture of the page.'],
          ['wallet_address', 'The machine wallet\'s address.'],
          ['wallet_sign_message, wallet_sign_transaction', 'Sign with the machine wallet.'],
          ['inbox_read', 'Read the machine\'s inbox.'],
          ['stop_computer', 'Stop the machine and get the bill.'],
          ['recover_wallet_key', 'Get a machine wallet key back after it stopped.'],
          ['balance', 'Credit left and what each machine has used.'],
        ]],
      ] },
      { id: 'inside', h: 'What is inside', k: 4.05, blocks: [
        ['opts', [
          ['Shell and files', 'A Linux machine. Your work lives in `/work`.'],
          ['Browser', 'Chromium, running inside the machine itself.'],
          ['Wallet', 'Its own Solana wallet. It signs messages and transactions.'],
          ['Inbox', 'A public address anyone can post to. Only you read it.'],
          ['Network', 'Only through three hops of the private network. Nothing else gets in or out.'],
        ]],
        ['p', 'Sizes: `small` is half a CPU, 256 MB memory and 256 MB disk. `medium` is 1 CPU, 1 GB and 1 GB. `large` is 2 CPUs, 2 GB and 4 GB.'],
      ] },
      { id: 'billing', h: 'Billing', k: 4.1, blocks: [
        ['p', 'You pay for every second the machine runs, never while it is paused. The tools pay 30 seconds ahead and never spend more than your credit. Each node sets its own price per second and the rent answer shows it.'],
        ['p', 'When the credit for a node runs low, the tools buy more by themselves, within your 24 hour top up limit (see [Payments](/docs/payments#top-up)).'],
        ['list', [
          'If payment stops, the machine pauses. With no payment for a minute, it is removed.',
          'A machine left unused for 15 minutes ends.',
          'Every machine ends after 24 hours.',
          'When it ends, its files are gone.',
        ]],
      ] },
      { id: 'wallet', h: 'The machine wallet', k: 4.16, blocks: [
        ['p', 'Send SOL to the machine wallet and the agent can spend it. The key is made on the node and never enters the machine.'],
        ['p', 'When the machine ends, the node keeps the key, encrypted, for 30 days so you can get it back. After 30 days it deletes it.'],
        ['code', `node bin/client.js recover-wallet --coordinator ${C} --node <node id> --machine <machine id>`],
        ['p', 'Run it with the same data folder you rented from: only the account that paid for the machine can get its key. The key is saved as a Solana keypair file in `~/.tangent/client/recovered/`. An agent does the same with `recover_wallet_key`.'],
      ] },
    ],
  },
  {
    path: '/docs/reference',
    nav: 'Reference',
    blurb: 'Every command and option.',
    title: 'Reference · Tangent Systems',
    h1: 'Reference',
    lede: 'Every command and option of the node, the client and the agent tools.',
    k: 4.5,
    sections: [
      { id: 'basics', h: 'Basics', k: 4.55, blocks: [
        ['p', `Run every command from ${BASE}, after \`npm install\`. Node.js 22 or newer. The code is on [GitHub](${REPO_URL}).`],
        ['p', '`--coordinator` is where the network lives. Use `' + C + '`. The client and agent tools also read it from `TANGENT_COORDINATOR`.'],
        ['p', 'Add `--help` to any of the three to see its options.'],
      ] },
      { id: 'node', h: 'node', k: 4.65, blocks: [
        ['code', `node bin/node.js --coordinator ${C} --host <address> [options]\nnode bin/node.js setup`],
        ['p', '`setup` gets the Docker images that rented computers use.'],
        ['opts', [
          ['--coordinator <url>', 'Where the network lives. Required.'],
          ['--host <address>', 'Public host name or IP that others reach this node at.'],
          ['--data <dir>', 'Data folder for keys, backups and off grid payments. Default `~/.tangent/node`.'],
          ['--bind <address>', 'Address to listen on. Default `0.0.0.0`.'],
          ['--relay-port <n>', 'Private internet port. Default `9101`; `0` picks a free one.'],
          ['--api-port <n>', 'Port for rented computers. Default `9102`.'],
          ['--offgrid-port <n>', 'Off grid peer port. Default `9103`.'],
          ['--peer <host:port>', 'Off grid peer to link with. Repeat for more.'],
          ['--udp-port <n>', 'Also find peers on the local network over UDP on this port.'],
          ['--exit', 'Be an exit: open connections to the open web.'],
          ['--gateway', 'Put off grid payments on chain. Needs `HELIUS_API_KEY` or `--rpc-url`.'],
          ['--rpc-url <url>', 'Solana RPC for the gateway.'],
          ['--cluster <name>', '`mainnet` (default) or `devnet`.'],
          ['--compute', 'Rent out sealed computers. Needs Docker.'],
          ['--compute-dev', 'For development without Docker. These machines are not sealed.'],
          ['--no-egress', 'Rented computers get no network at all.'],
          ['--mcp', 'Agent tools at `/mcp` on the port for rented computers, for this machine only, paid from the node\'s wallet.'],
          ['--payout <address>', 'Your own registered Privacy Rings wallet for payouts. Default: a payout wallet the node makes.'],
          ['--region <name>', 'Rough region shown on the map, for example `eu-west`.'],
          ['--price-mb <lamports>', 'Price per MB carried. Default `10000`.'],
          ['--price-tx <lamports>', 'Price per off grid payment. Default `0`; tips pay carriers.'],
          ['--price-second <lamports>', 'Price per second of a small computer. Default `1000`; medium is twice that, large four times.'],
          ['--tor-control <host:port>', 'Also publish the relay as a Tor onion service. Password from `TOR_CONTROL_PASSWORD`.'],
          ['--coordinator-id <id>', 'Pin the network identity instead of reading it on start.'],
          ['--dev-allow-private', 'For development: allow private and loopback addresses.'],
        ]],
      ] },
      { id: 'client', h: 'client', k: 4.75, blocks: [
        ['code', `node bin/client.js <command> --coordinator ${C} [options]`],
        ['p', 'Every command also takes `--data <dir>` (default `~/.tangent/client`) and `--coordinator-id <id>`. Answers are printed as JSON.'],
        ['opts', [
          ['wallet', 'Your wallet address. Made on first use.'],
          ['deposit', 'Where to send SOL through Privacy Rings for this wallet.'],
          ['balance', 'Wallet balance and the credit left on each throwaway account. `current` marks the account each node is paid from now.'],
          ['credit', 'Buy credit: one throwaway account per node that has none. `--nodes <ids>` comma separated (default every live node), `--tokens <n>` per account (default `1`). `--top-up` also adds `--tokens` to nodes that already have an account, on a fresh throwaway account; with `--same-account` on the account the node already has.'],
          ['withdraw', 'Send wallet balance out through Privacy Rings and wait until it has left. `--to <address>`, `--lamports <n>`, `--public` for a plain public address, `--timeout-sec <n>` (default `120`). `--id <withdrawal id>` follows an earlier one.'],
          ['proxy', 'Private internet: a local SOCKS5 proxy over three hops. `--socks-port <n>` (default `1080`), `--hops <n>` (default `3`), `--tokens <n>` per node and per top up (default `1`), `--top-up-limit <lamports>`, `--same-account`.'],
          ['rent', 'Rent a computer, run commands, stop it, print the bill. `--node <id>`, `--image <name>`, `--size <small|medium|large>`, `--cmd "<command>"` (repeat), `--hold-seconds <n>`, `--tokens <n>`, `--top-up-limit <lamports>`.'],
          ['recover-wallet', 'Get back the wallet key of a computer you rented. `--node <id>` and `--machine <id>`. Saved to `<data>/recovered/`.'],
          ['offgrid-send', 'Send a payment without internet and wait for its receipt. `--peer <host:port>`, `--keypair <file>`, `--nonce-account <address>`, `--nonce-value <hash>`, `--to <address>`, `--lamports <n>`, `--tip <lamports>`, `--tip-account <address>`, `--timeout-sec <n>` (default `120`).'],
          ['mcp', 'Agent tools on stdio. `--node <id>` to pick a node, `--http <port>` to serve them on `127.0.0.1` instead, `--tokens <n>`, `--top-up-limit <lamports>`.'],
        ]],
        ['p', 'Automatic top up: `proxy`, `rent` and `mcp` buy more credit by themselves when a node\'s account runs low. `--top-up-limit` is the most they spend that way in any 24 hours, across every run with the same data folder (default `10000000`, which is 0.01 SOL; `0` turns it off).'],
      ] },
      { id: 'mcp', h: 'mcp', k: 4.85, blocks: [
        ['code', `node bin/mcp.js --coordinator ${C} [--node <id>] [--data <dir>]`],
        ['p', 'The same as `client.js mcp`, for agent settings files. The tools are listed in [Agents](/docs/agents#mcp).'],
      ] },
      { id: 'environment', h: 'Environment', k: 5, blocks: [
        ['opts', [
          ['TANGENT_COORDINATOR', 'Client and agent tools: used when `--coordinator` is left out.'],
          ['HELIUS_API_KEY', 'Node: Solana RPC for `--gateway` and for registering its own payout wallet.'],
          ['TOR_CONTROL_PASSWORD', 'Node: password of the Tor control port.'],
          ['DOCKER_HOST', 'Node: the Docker to use for `--compute`.'],
        ]],
      ] },
    ],
  },
];

export const DOCS_INDEX = {
  path: '/docs',
  nav: 'Docs',
  title: 'Docs · Tangent Systems',
  word: 'DOCS',
  hero: 'Guides for using and running the network.',
  // where the camera sits while each guide's row is read
  rows: { '/docs/run-a-node': 1, '/docs/payments': 1.3, '/docs/private-internet': 2, '/docs/off-grid': 3, '/docs/agents': 4, '/docs/reference': 5 },
};

// Every command line shown anywhere on the site, for tests.
export function shownCode() {
  const out = [];
  for (const p of PAGES) for (const c of Object.values(p.cmd || {})) out.push(c);
  for (const g of GUIDES) for (const s of g.sections) for (const b of s.blocks) if (b[0] === 'code') out.push(b[1]);
  return out;
}
