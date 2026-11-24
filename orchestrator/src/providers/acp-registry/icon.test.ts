/**
 * The registry logo, offline: what address is fetched, what SVG is kept.
 */
import '../../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Fetcher } from './download.js';
import { checkedIconSvg, fetchIcon, readIcon, writeIcon } from './icon.js';
import { parseRegistry, trustedIconUrl } from './schema.js';

const ICON_URL = 'https://cdn.agentclientprotocol.com/registry/v1/latest/mistral-vibe.svg';
const LOGO = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="currentColor" d="M0 0h24v24H0z"/></svg>';

function served(body: string | { status: number; headers?: Record<string, string> }, seen: string[] = []): Fetcher {
  return async (url) => {
    seen.push(url);
    if (typeof body === 'string') return new Response(body, { status: 200 });
    return new Response(null, { status: body.status, ...(body.headers ? { headers: body.headers } : {}) });
  };
}

const work = () => mkdtempSync(join(tmpdir(), 'timon-acp-icon-'));

test('schema: only an https icon on the registry CDN is kept; anything else is dropped without dropping the agent', () => {
  assert.equal(trustedIconUrl(ICON_URL), ICON_URL);
  for (const bad of [
    'https://evil.example/logo.svg',
    'https://cdn.agentclientprotocol.com.evil.example/logo.svg',
    'http://cdn.agentclientprotocol.com/registry/v1/latest/x.svg',
    'https://cdn.agentclientprotocol.com:8443/x.svg',
    'https://user:pass@cdn.agentclientprotocol.com/x.svg',
    `https://cdn.agentclientprotocol.com/${'a'.repeat(2048)}.svg`,
    'not a url',
    42,
    null,
  ]) assert.equal(trustedIconUrl(bad), undefined, String(bad).slice(0, 80));

  const agent = (id: string, icon?: unknown) => ({ id, name: id, version: '1.0.0', ...(icon === undefined ? {} : { icon }), distribution: {} });
  const parsed = parseRegistry({ version: '1', agents: [agent('kept', ICON_URL), agent('off-host', 'https://evil.example/x.svg'), agent('odd', { a: 1 }), agent('none')] });
  assert.equal(parsed.dropped, 0);
  assert.deepEqual(parsed.agents.map((a) => [a.id, a.icon]), [['kept', ICON_URL], ['off-host', undefined], ['odd', undefined], ['none', undefined]]);
});

test('check: the provider brand rule decides; an XML prolog is set aside first', () => {
  assert.deepEqual(checkedIconSvg(LOGO), { svg: LOGO });
  assert.deepEqual(checkedIconSvg(`﻿<?xml version="1.0" standalone="no" ?>\n${LOGO}`), { svg: LOGO });
  for (const bad of [
    '<svg><script>alert(1)</script></svg>',
    '<svg onload="alert(1)"><path/></svg>',
    '<svg><image href="https://tracker.example/p.png"/></svg>',
    '<svg><use xlink:href="//tracker.example/s.svg#a"/></svg>',
    `<svg>${' '.repeat(17 * 1024)}</svg>`,
    '<html><svg/></html>',
  ]) assert.ok('problem' in checkedIconSvg(bad), bad.slice(0, 60));
});

test('fetch: a valid icon is returned, the downloaded file is not left behind', async () => {
  const dir = work();
  const seen: string[] = [];
  assert.deepEqual(await fetchIcon(ICON_URL, dir, served(LOGO, seen)), { kind: 'svg', svg: LOGO });
  assert.deepEqual(seen, [ICON_URL]);
  assert.deepEqual(readdirSync(dir), []);
});

test('fetch: no address means no request', async () => {
  const seen: string[] = [];
  assert.deepEqual(await fetchIcon(undefined, work(), served(LOGO, seen)), { kind: 'none' });
  assert.deepEqual(seen, []);
});

test('fetch: unsafe, oversized, unreachable or redirected icons fail softly, and the reason names no address', async () => {
  // `refused` judges the icon itself (the kept one is dropped); `unreachable` only the road to it (the kept one stays).
  const cases: Array<[string, Fetcher, 'refused' | 'unreachable']> = [
    ['script', served('<svg><script>alert(1)</script></svg>'), 'refused'],
    ['not an svg', served('<html><svg/></html>'), 'refused'],
    ['oversized', served(`<svg>${' '.repeat(17 * 1024)}</svg>`), 'refused'],
    ['http error', served({ status: 503 }), 'unreachable'],
    ['redirect', served({ status: 302, headers: { location: 'https://elsewhere.example/x.svg' } }), 'unreachable'],
    ['network', async () => { throw new Error('ECONNRESET'); }, 'unreachable'],
  ];
  for (const [name, fetchFn, kind] of cases) {
    const outcome = await fetchIcon(ICON_URL, work(), fetchFn);
    assert.equal(outcome.kind, kind, name);
    if (outcome.kind === 'refused' || outcome.kind === 'unreachable') {
      assert.doesNotMatch(outcome.reason, /https?:|agentclientprotocol|elsewhere/, name);
    }
  }
});

test('read: the kept file is checked again, and a missing one is no logo', () => {
  const file = join(work(), 'icons', 'agent.svg');
  assert.equal(readIcon(file), null);
  writeIcon(file, LOGO);
  assert.equal(readIcon(file), LOGO);
  writeFileSync(file, '<svg onload="alert(1)"></svg>');
  assert.equal(readIcon(file), null, 'a file edited by hand is dropped');
  writeFileSync(file, `<svg>${' '.repeat(17 * 1024)}</svg>`);
  assert.equal(readIcon(file), null);
  assert.equal(existsSync(file), true, 'reading never deletes');
});
