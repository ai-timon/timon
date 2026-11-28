/** Private daemon↔Electron transport of the computer-native service (same shape as the native browser's). */
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { authorizedBearer } from './native-browser-protocol.js';
import { ComputerCommandError, parseAllowedApps, parseComputerActor, parseComputerCommand, parseComputerMode, type AllowedApp, type ComputerActor, type ComputerCommand, type ComputerUseMode } from './computer-use-protocol.js';
import { pointerLabel } from './computer-use-pointer.js';

export interface ComputerProviderDescriptor {
  version: 1;
  origin: string;
  token: string;
  pid: number;
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!request.headers['content-type']?.startsWith('application/json')) {
    throw new ComputerCommandError('Expected application/json.', 415, 'unsupported_media_type');
  }
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw new ComputerCommandError('Command is too large.', 413, 'too_large');
    chunks.push(Buffer.from(chunk));
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ComputerCommandError('Invalid JSON command.'); }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ComputerCommandError('Expected a JSON object.');
  return value as Record<string, unknown>;
}

export async function startComputerServer(
  home: string,
  handle: (actor: ComputerActor, command: ComputerCommand, allowedApps: AllowedApp[], mode: ComputerUseMode, agent: string | undefined) => Promise<unknown>,
): Promise<{ descriptor: ComputerProviderDescriptor; close: () => Promise<void> }> {
  const token = randomBytes(32).toString('hex');
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      // A request carrying an Origin comes from a web page, never from the daemon.
      if (request.headers.origin || !authorizedBearer(request.headers.authorization, token)) {
        throw new ComputerCommandError('Unauthorized computer provider request.', 401, 'unauthorized');
      }
      if (request.method !== 'POST' || request.url !== '/command') {
        throw new ComputerCommandError('Unknown computer provider route.', 404, 'not_found');
      }
      const body = await readBody(request);
      const command = parseComputerCommand(body.command, body.args);
      // The agent's name labels the ghost pointer and nothing else.
      const result = await handle(parseComputerActor(body.actor), command, parseAllowedApps(body.allowedApps, parseComputerMode(body.mode)), parseComputerMode(body.mode), pointerLabel(body.agent));
      response.end(JSON.stringify({ ok: true, result }));
    } catch (error) {
      const known = error instanceof ComputerCommandError;
      response.statusCode = known ? error.statusCode : 500;
      response.end(JSON.stringify({
        ok: false,
        error: known ? error.message : 'Computer command failed.',
        code: known ? error.code : 'internal_error',
      }));
    }
  });
  server.requestTimeout = 60_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Computer provider did not bind loopback.');
  const descriptor: ComputerProviderDescriptor = { version: 1, origin: `http://127.0.0.1:${address.port}`, token, pid: process.pid };
  const directory = join(home, 'computer-native');
  const path = join(directory, 'provider.json');
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    await writeFile(temporary, JSON.stringify(descriptor), { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
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
        const current = JSON.parse(await readFile(path, 'utf8')) as ComputerProviderDescriptor;
        if (current.token === token) await unlink(path);
      } catch { /* Already removed during shutdown. */ }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
