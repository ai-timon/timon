/** Private daemon↔Electron transport. There is deliberately no browser/CDP listener. */
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { replaceFile } from './replace-file.js';
import { authorizedBearer, BrowserCommandError, objectOf } from './native-browser-protocol.js';

export interface NativeBrowserProviderDescriptor {
  version: 1;
  origin: string;
  token: string;
  pid: number;
}

/** What the provider dispatches to: the engine, and the capture of its tabs. */
export interface ProviderTargets {
  browser: { command(body: Record<string, unknown>): Promise<unknown> };
  media: { command(body: Record<string, unknown>): Promise<unknown>; closeProfile(profileId: string): void };
}

/** One command of the daemon: a stream command goes to the capture, every other to the engine. */
export function providerCommand(targets: () => ProviderTargets): (body: Record<string, unknown>) => Promise<unknown> {
  return (body) => {
    const { browser, media } = targets();
    if (typeof body.action === 'string' && body.action.startsWith('media')) return media.command(body);
    // A stopped profile ends its streams first: they would capture a closed tab.
    if (body.action === 'stop' && typeof body.profileId === 'string') media.closeProfile(body.profileId);
    return browser.command(body);
  };
}

async function readCommand(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!request.headers['content-type']?.startsWith('application/json')) {
    throw new BrowserCommandError('Expected application/json.', 415);
  }
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 256 * 1024) throw new BrowserCommandError('Command is too large.', 413);
    chunks.push(Buffer.from(chunk));
  }
  try { return objectOf(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
  catch (error) {
    if (error instanceof BrowserCommandError) throw error;
    throw new BrowserCommandError('Invalid JSON command.');
  }
}

export async function startNativeBrowserServer(
  home: string, command: (body: Record<string, unknown>) => Promise<unknown>,
): Promise<{ descriptor: NativeBrowserProviderDescriptor; close: () => Promise<void> }> {
  const token = randomBytes(32).toString('hex');
  let descriptor: NativeBrowserProviderDescriptor;
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      // Origin-bearing browser requests never belong on this private transport.
      if (request.headers.origin || !authorizedBearer(request.headers.authorization, token)) {
        throw new BrowserCommandError('Unauthorized browser provider request.', 401);
      }
      if (request.method !== 'POST' || request.url !== '/command') {
        throw new BrowserCommandError('Unknown browser provider route.', 404);
      }
      const result = await command(await readCommand(request));
      response.end(JSON.stringify(result));
    } catch (error) {
      response.statusCode = error instanceof BrowserCommandError ? error.statusCode : 500;
      const code = error instanceof BrowserCommandError ? error.code : undefined;
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Browser command failed.', ...(code ? { code } : {}) }));
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Browser provider did not bind loopback.');
  descriptor = { version: 1, origin: `http://127.0.0.1:${address.port}`, token, pid: process.pid };
  const directory = join(home, 'browser-native');
  const path = join(directory, 'provider.json');
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    await writeFile(temporary, JSON.stringify(descriptor), { mode: 0o600 });
    await chmod(temporary, 0o600);
    await replaceFile(temporary, path);
  } catch (error) {
    server.close();
    await unlink(temporary).catch(() => {});
    throw error;
  }

  return {
    descriptor,
    close: async () => {
      // A stale process must not remove the replacement provider's descriptor.
      try {
        const current = JSON.parse(await readFile(path, 'utf8')) as NativeBrowserProviderDescriptor;
        if (current.token === token) await unlink(path);
      } catch { /* It may already have been removed during shutdown. */ }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
