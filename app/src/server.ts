/**
 * The cockpit's HTTP server.
 *
 * Next handles everything, with one exception: the WebSocket upgrades of the
 * built-in terminal (`lib/ui/terminal-ws-proxy.ts`). A Next route handler
 * never sees them (the `Request`/`Response` API does not expose the upgrade)
 * — hence this custom server, which relays those upgrades and hands
 * everything else to the Next handler.
 *
 * Started by `npm start` / `npm run dev` through tsx.
 */
import http from 'node:http';
import next from 'next';
import { createHostPolicyReader, hostAllowed, hostGuardExempt } from './lib/host-guard';
import { listenHostsFor } from './lib/listen-hosts';
import { TIMON_HOME } from './lib/paths';
import { useStandaloneConfig } from './lib/standalone-config';
import { handleTerminalUpgrade, matchTerminalWsPath } from './lib/ui/terminal-ws-proxy';
import { createWindowPolicy } from './lib/ui/window-csp';

const dev = process.env.NODE_ENV !== 'production';
const port = Number(process.env.PORT ?? 3100);
const hostname = process.env.HOSTNAME_BIND ?? '0.0.0.0';

if (!dev) useStandaloneConfig(process.cwd());

// Next attaches its own `upgrade` listener to the server of the first request
// it handles (`setupWebSocketHandler`), and in production that listener
// destroys every socket it does not route itself — including the terminal
// upgrades this server proxies, while they wait for their upstream.
// The only place Next looks for that server is `httpServer`: hand it a decoy
// that never listens. HMR in dev goes through `getUpgradeHandler()` below.
const nextUpgradeDecoy = http.createServer();
const app = next({ dev, hostname, port, dir: process.cwd(), httpServer: nextUpgradeDecoy });
const handle = app.getRequestHandler();
// Every response, before Next sees the request (TODO #533).
const windowPolicy = createWindowPolicy({ dev });
// Here rather than in `middleware.ts`: that one skips `/api/`, the proxy to
// the daemon, and never sees the terminal's WebSocket upgrades.
const hostPolicy = createHostPolicyReader(TIMON_HOME);

function misdirected(req: http.IncomingMessage): boolean {
  return !hostGuardExempt(req.url) && !hostAllowed(req.headers.host, hostPolicy());
}

function createServer(): http.Server {
  const server = http.createServer((req, res) => {
    if (misdirected(req)) {
      res.writeHead(421, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'misdirected request' }));
      return;
    }
    // No policy, no page: a response never leaves without it.
    void windowPolicy(req, res).then(() => handle(req, res), () => {
      res.statusCode = 500;
      res.end();
    });
  });

  server.on('upgrade', (req, socket, head) => {
    if (misdirected(req)) {
      socket.destroy();
      return;
    }
    const terminal = matchTerminalWsPath(req.url);
    if (terminal) {
      void handleTerminalUpgrade(terminal, req, socket, head).catch(() => socket.destroy());
      return;
    }
    // Next's HMR in dev: its own WS server lives behind `getUpgradeHandler`.
    if (dev) {
      void app.getUpgradeHandler()(req, socket, head);
      return;
    }
    socket.destroy();
  });

  return server;
}

async function main(): Promise<void> {
  await app.prepare();

  // One socket per loopback family (step 5.9.1): `localhost` resolves to `::1`
  // on many machines, and an IPv4-only bind then answered nothing there — the
  // page loaded and every chunk request timed out. Node needs one server per
  // address, so we create one per host rather than binding `::`, which would
  // publish the UI on every interface.
  const hosts = listenHostsFor(hostname);
  hosts.forEach((host, index) => {
    const server = createServer();
    server.on('error', (err: NodeJS.ErrnoException) => {
      // The primary address is the contract; the secondary is a courtesy, and
      // a machine with IPv6 switched off must still start.
      if (index === 0) throw err;
      console.warn(`[timon-app] not listening on ${host}: ${err.code ?? err.message}`);
    });
    server.listen(port, host, () => {
      // Bracketed for IPv6, so the line can be pasted into a browser as is.
      const shown = host.includes(':') ? `[${host}]` : host;
      console.log(`[timon-app] http://${shown}:${port} (dev=${dev})`);
    });
  });
}

void main();
