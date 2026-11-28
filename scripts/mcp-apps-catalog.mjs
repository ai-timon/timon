#!/usr/bin/env node
// The Apps catalogue (`@timon/mcp-apps`) against the official MCP registry.
//
// The entries Timon ships are data reviewed by hand, one JSON file per
// publisher (orchestrator/src/plugins-bundled/mcp-apps/catalog/). This tool
// never writes there: it reads the registry and tells a maintainer what to
// review, what drifted, and whether each endpoint still answers.
//
// Usage:
//   node scripts/mcp-apps-catalog.mjs propose --search <term> [--out <dir>] [--limit <n>]
//                                                             # candidates, into a scratch folder
//   node scripts/mcp-apps-catalog.mjs check                   # reviewed entries vs the registry (exit 1 on drift)
//   node scripts/mcp-apps-catalog.mjs probe [slug…]           # live auth probe of the reviewed entries (exit 1 on failure)
//
// "Official" (docs/MCP-APPS.md §2): the registry verifies a namespace by DNS or
// HTTP proof of its domain (`com.sentry/…`), or by GitHub proof of an
// organisation (`io.github.getsentry/…`). An automatic proposal needs the
// domain proof AND an endpoint hosted on that domain, never on a shared host
// (`*.vercel.app` proves the app's author, not Vercel). Anything else — a
// GitHub namespace, an endpoint on another domain of the publisher — is only
// accepted on an entry that says so (`registry.proof: "documented"`) and names
// a page of the publisher that gives the endpoint (`registry.evidence`), which
// `probe` reads again.
//
// No npm dependency on purpose: Node's fetch, fs and path only, so the tool
// runs the same on the three OSes and in a bare CI image.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const CATALOG_DIR = join(ROOT, 'orchestrator', 'src', 'plugins-bundled', 'mcp-apps', 'catalog');
export const REGISTRY = 'https://registry.modelcontextprotocol.io/v0/servers';

/**
 * Suffixes under which anyone can publish: a namespace there proves who owns
 * one app, not the platform. Checked on the namespace domain and on the
 * endpoint host alike.
 */
export const SHARED_HOST_SUFFIXES = Object.freeze([
  'vercel.app', 'netlify.app', 'workers.dev', 'pages.dev', 'trycloudflare.com', 'onrender.com',
  'up.railway.app', 'railway.app', 'herokuapp.com', 'fly.dev', 'github.io', 'gitlab.io', 'run.app',
  'appspot.com', 'azurewebsites.net', 'amazonaws.com', 'cloudfront.net', 'ngrok.io', 'ngrok-free.app',
  'deno.dev', 'replit.app', 'repl.co', 'glitch.me', 'smithery.ai', 'apify.actor', 'mcp-use.com',
]);

/** `com.figma.mcp/mcp` → `mcp.figma.com`; `null` for a GitHub namespace or a malformed name. */
export function namespaceDomain(name) {
  if (typeof name !== 'string') return null;
  const slash = name.indexOf('/');
  if (slash <= 0) return null;
  const ns = name.slice(0, slash).toLowerCase();
  if (ns.startsWith('io.github.')) return null;
  const labels = ns.split('.');
  if (labels.length < 2 || labels.some((l) => !/^[a-z0-9-]+$/.test(l))) return null;
  return labels.reverse().join('.');
}

/** `io.github.getsentry/sentry-mcp` → `getsentry`; `null` otherwise. */
export function githubNamespace(name) {
  const m = /^io\.github\.([A-Za-z0-9-]+)\//.exec(typeof name === 'string' ? name : '');
  return m ? m[1] : null;
}

function isUnder(host, domain) {
  return host === domain || host.endsWith('.' + domain);
}

export function isSharedHost(host) {
  return SHARED_HOST_SUFFIXES.some((s) => isUnder(host, s));
}

/**
 * Whether `url` is hosted by the publisher that proved `name`'s domain. A
 * subdomain counts both ways (`com.figma.mcp` hosted on `mcp.figma.com`,
 * `app.linear` hosted on `mcp.linear.app`): one is a subdomain of the other.
 */
export function hostedByNamespace(name, url) {
  const domain = namespaceDomain(name);
  if (!domain || isSharedHost(domain)) return false;
  let host;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    host = u.hostname.toLowerCase();
  } catch {
    return false;
  }
  if (isSharedHost(host)) return false;
  return isUnder(host, domain) || isUnder(domain, host);
}

/** The http remotes of a registry server, streamable-http first. */
export function httpRemotes(server) {
  const remotes = Array.isArray(server?.remotes) ? server.remotes : [];
  return remotes
    .filter((r) => r && (r.type === 'streamable-http' || r.type === 'sse') && typeof r.url === 'string')
    .sort((a, b) => (a.type === b.type ? 0 : a.type === 'streamable-http' ? -1 : 1));
}

/** A URL template (`{token}`) or a secret in the query cannot be a catalogue endpoint. */
export function usableEndpoint(url) {
  if (/[{}]/.test(url)) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && ![...u.searchParams.keys()].some((k) => /key|token|secret/i.test(k));
  } catch {
    return false;
  }
}

/**
 * A draft entry for a maintainer to complete; `null` when the server is not
 * official by the domain rule. Every `TODO` must be replaced, and the entry
 * probed, before it is copied into the catalogue: the schema refuses `TODO`
 * as a category and an empty example list.
 */
export function proposalFrom(server, today = new Date().toISOString().slice(0, 10)) {
  const remote = httpRemotes(server).find((r) => usableEndpoint(r.url) && hostedByNamespace(server.name, r.url));
  if (!remote) return null;
  const headers = (Array.isArray(remote.headers) ? remote.headers : []).map((h) => h?.name).filter(Boolean);
  const domain = namespaceDomain(server.name);
  const slug = domain.split('.').slice(-2, -1)[0];
  return {
    slug,
    name: server.title || slug,
    publisher: server.title || slug,
    category: 'TODO',
    tagline: { en: server.description || '', fr: 'TODO' },
    description: { en: server.description || '', fr: 'TODO' },
    examples: { en: [], fr: [] },
    mcp: { url: remote.url, transport: remote.type },
    auth: headers.length
      ? { type: 'key', header: headers[0], prefix: '', help_url: 'TODO', label: { en: 'TODO', fr: 'TODO' } }
      : { type: 'oauth' },
    links: { website: server.websiteUrl || `https://${domain}`, privacy: 'TODO', terms: 'TODO' },
    registry: { name: server.name, proof: 'domain' },
    icon: { monogram: slug.slice(0, 2).replace(/^./, (c) => c.toUpperCase()), color: '#64748B' },
    reviewed: { on: today, probe: 'TODO: node scripts/mcp-apps-catalog.mjs probe ' + slug },
  };
}

/** Every reviewed entry, as parsed JSON with its file name. */
export function readCatalog(dir = CATALOG_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((file) => ({ file, entry: JSON.parse(readFileSync(join(dir, file), 'utf8')) }));
}

async function fetchJson(url, init) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.json();
}

/** The latest version of every registry server, following the cursor to the end. */
export async function* registryServers({ search, fetcher = fetchJson } = {}) {
  let cursor = null;
  for (;;) {
    const u = new URL(REGISTRY);
    u.searchParams.set('limit', '100');
    u.searchParams.set('version', 'latest');
    if (search) u.searchParams.set('search', search);
    if (cursor) u.searchParams.set('cursor', cursor);
    const page = await fetcher(u.toString());
    for (const item of page.servers ?? []) yield item;
    cursor = page.metadata?.nextCursor ?? null;
    if (!cursor) return;
  }
}

/** The registry record of one name, or `null`. */
async function registryRecord(name, fetcher) {
  for await (const item of registryServers({ search: name, fetcher })) {
    if (item.server?.name === name) return item;
  }
  return null;
}

/**
 * What changed between a reviewed entry and the registry: the server is gone or
 * deleted, the endpoint left its remotes, or its proof no longer holds.
 */
export function driftOf(entry, record) {
  const problems = [];
  if (!record) return [`${entry.registry.name} is no longer in the registry`];
  const status = record._meta?.['io.modelcontextprotocol.registry/official']?.status;
  if (status && status !== 'active') problems.push(`registry status is ${status}`);
  const remotes = httpRemotes(record.server).map((r) => r.url);
  if (entry.registry.proof === 'domain') {
    if (!remotes.includes(entry.mcp.url)) problems.push(`${entry.mcp.url} is not among its remotes (${remotes.join(', ') || 'none'})`);
    if (!hostedByNamespace(entry.registry.name, entry.mcp.url)) {
      problems.push(`${entry.mcp.url} is not hosted on the namespace domain of ${entry.registry.name}`);
    }
  }
  if (entry.registry.proof === 'documented' && !/^https:\/\//.test(entry.registry.evidence ?? '')) {
    problems.push('proof "documented" without an https evidence page');
  }
  if (entry.registry.proof !== 'domain' && entry.registry.proof !== 'documented') {
    problems.push(`unknown proof ${entry.registry.proof}`);
  }
  return problems;
}

const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'timon', version: '0' } },
});

async function safeJson(url) {
  try {
    return await fetchJson(url, { headers: { accept: 'application/json' } });
  } catch {
    return null;
  }
}

function asMetadataUrl(issuer) {
  const u = new URL(issuer);
  return `${u.origin}/.well-known/oauth-authorization-server${u.pathname.replace(/\/$/, '')}`;
}

/**
 * The same discovery as the daemon's `discoverOAuth` (orchestrator/src/oauth.ts),
 * step for step, so that a pass here means "Connect" can work there; plus the
 * one thing the daemon then needs and cannot do without, dynamic registration.
 */
export async function probeEntry(entry) {
  if (entry.registry?.proof === 'documented') {
    const host = new URL(entry.mcp.url).host;
    let page = '';
    try {
      const r = await fetch(entry.registry.evidence, { headers: { 'user-agent': 'Mozilla/5.0 (timon catalogue probe)' }, signal: AbortSignal.timeout(20_000) });
      page = r.ok ? await r.text() : '';
    } catch { /* reported below */ }
    if (!page.includes(host)) return { ok: false, detail: `evidence ${entry.registry.evidence} does not name ${host}` };
  }
  return probeEndpoint(entry);
}

async function probeEndpoint(entry) {
  const url = entry.mcp.url;
  let first;
  try {
    first = await fetch(url, {
      method: 'POST',
      headers: { accept: 'application/json,text/event-stream', 'content-type': 'application/json' },
      body: INITIALIZE,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    return { ok: false, detail: `unreachable: ${e.message}` };
  }
  if (entry.auth.type === 'none') {
    return first.ok ? { ok: true, detail: `initialize → ${first.status}` } : { ok: false, detail: `initialize → ${first.status}` };
  }
  if (entry.auth.type === 'key') {
    let invalid;
    try {
      invalid = await fetch(url, {
        method: 'POST',
        headers: {
          accept: 'application/json,text/event-stream',
          'content-type': 'application/json',
          [entry.auth.header]: `${entry.auth.prefix ?? ''}timon_invalid_probe_key`,
        },
        body: INITIALIZE,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      return { ok: false, detail: `invalid-key probe unreachable: ${e.message}` };
    }
    if (invalid.status !== 401 && invalid.status !== 403) {
      return { ok: false, detail: `invalid key initialize → ${invalid.status}, expected 401/403` };
    }
    return first.ok || first.status === 401 || first.status === 403
      ? { ok: true, detail: `anonymous initialize → ${first.status}; invalid key → ${invalid.status}` }
      : { ok: false, detail: `anonymous initialize → ${first.status}, expected success or 401/403` };
  }
  const origin = new URL(url).origin;
  const issuers = [];
  const hint = first.status === 401 ? /resource_metadata="([^"]+)"/i.exec(first.headers.get('www-authenticate') || '')?.[1] : undefined;
  if (hint) {
    const rmd = await safeJson(hint);
    for (const as of Array.isArray(rmd?.authorization_servers) ? rmd.authorization_servers : []) issuers.push(asMetadataUrl(as));
  }
  if (!issuers.length) {
    const rmd = await safeJson(origin + '/.well-known/oauth-protected-resource');
    for (const as of Array.isArray(rmd?.authorization_servers) ? rmd.authorization_servers : []) issuers.push(asMetadataUrl(as));
  }
  if (!issuers.length) issuers.push(origin + '/.well-known/oauth-authorization-server');
  for (const metaUrl of issuers) {
    const md = await safeJson(metaUrl);
    if (typeof md?.authorization_endpoint !== 'string' || typeof md?.token_endpoint !== 'string') continue;
    if (typeof md.registration_endpoint !== 'string') {
      return { ok: false, detail: `${metaUrl}: no registration_endpoint (dynamic client registration unavailable)` };
    }
    return { ok: true, detail: `first call → ${first.status}, metadata ${metaUrl}, registration ${md.registration_endpoint}` };
  }
  return { ok: false, detail: `no OAuth metadata (first call → ${first.status}, tried ${issuers.join(', ')})` };
}

function argValue(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

async function propose(args) {
  // Tens of thousands of registry servers pass the domain rule (any company
  // publishing under its own domain does): without a search term the folder
  // would be unreadable, so one is required.
  const search = argValue(args, '--search');
  if (!search) {
    console.error('propose needs --search <term> (a publisher or product name)');
    process.exitCode = 2;
    return;
  }
  const limit = Number(argValue(args, '--limit') ?? 50);
  const out = resolve(argValue(args, '--out') ?? join(tmpdir(), 'timon-mcp-apps-proposals'));
  const reviewed = new Set(readCatalog().map(({ entry }) => entry.registry?.name));
  const reviewedSlugs = new Set(readCatalog().map(({ entry }) => entry.slug));
  mkdirSync(out, { recursive: true });
  let seen = 0;
  let written = 0;
  for await (const item of registryServers({ search })) {
    if (written >= limit) break;
    seen++;
    if (reviewed.has(item.server?.name)) continue;
    const draft = proposalFrom(item.server);
    if (!draft) continue;
    if (item._meta?.['io.modelcontextprotocol.registry/official']?.status === 'deleted') continue;
    const file = join(out, `${draft.slug}${reviewedSlugs.has(draft.slug) ? '.candidate' : ''}.json`);
    // A draft in the scratch folder may have been edited: same rule as the catalogue.
    if (existsSync(file)) continue;
    writeFileSync(file, JSON.stringify(draft, null, 2) + '\n');
    written++;
  }
  console.log(`${seen} registry servers read, ${written} new proposals in ${out}`);
  console.log('Review one, complete it (texts, category, links, examples), probe it, then copy it into the catalogue.');
}

async function check() {
  let drift = 0;
  for (const { file, entry } of readCatalog()) {
    const record = await registryRecord(entry.registry.name, fetchJson);
    const problems = driftOf(entry, record);
    if (problems.length) {
      drift++;
      console.log(`✗ ${file}: ${problems.join('; ')}`);
    } else {
      console.log(`✓ ${file}`);
    }
  }
  if (drift) process.exitCode = 1;
}

async function probe(slugs) {
  let failed = 0;
  for (const { file, entry } of readCatalog()) {
    if (slugs.length && !slugs.includes(entry.slug)) continue;
    const r = await probeEntry(entry);
    if (!r.ok) failed++;
    console.log(`${r.ok ? '✓' : '✗'} ${file} [${entry.auth.type}] ${r.detail}`);
  }
  if (failed) process.exitCode = 1;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [command, ...rest] = process.argv.slice(2);
  const run = command === 'propose' ? propose(rest)
    : command === 'check' || command === '--check' ? check()
      : command === 'probe' ? probe(rest.filter((a) => !a.startsWith('--')))
        : null;
  if (!run) {
    console.error('usage: node scripts/mcp-apps-catalog.mjs propose [--out <dir>] | check | probe [slug…]');
    process.exitCode = 2;
  } else {
    run.catch((e) => { console.error(e.message); process.exitCode = 1; });
  }
}
