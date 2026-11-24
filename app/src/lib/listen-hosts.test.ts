import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLoopbackHost, listenHostsFor } from './listen-hosts';
import { middleware, redirectTo } from '../middleware';
import { NextRequest } from 'next/server';

/**
 * The first real launch of the package (04/09/2026): the page rendered, links
 * highlighted on hover, and clicking did nothing. Cause: the redirect moved
 * the origin to `localhost`, which resolves to `::1` on this machine, while
 * the app listened on IPv4 only — every webpack chunk timed out and the client
 * router died without a word on screen.
 *
 * The relative `Location` posted then did not hold (step 5.9.6): Next's
 * adapter reparses it without a base and throws `Invalid URL`. The redirect is
 * now absolute, built on the origin the CLIENT used — the proof through the
 * real adapter lives in `middleware-adapter.test.ts`.
 */
test("a redirect keeps the client's origin", () => {
  const req = new NextRequest('http://localhost:3110/dashboard', {
    headers: { host: '127.0.0.1:3110' },
  });
  const res = redirectTo(req, '/login');
  assert.equal(res.status, 307);
  assert.equal(res.headers.get('location'), 'http://127.0.0.1:3110/login');
});

test('a page without a session goes to /login, on the same origin', () => {
  const res = middleware(new NextRequest('http://localhost:3110/dashboard', {
    headers: { host: '127.0.0.1:3110' },
  }));
  assert.equal(res.status, 307);
  assert.equal(res.headers.get('location'), 'http://127.0.0.1:3110/login');
});

test('a session is let through', () => {
  const req = new NextRequest('http://127.0.0.1:3110/dashboard');
  req.cookies.set('timon_session', 'abc');
  const res = middleware(req);
  assert.notEqual(res.status, 307);
});

/**
 * The second lever: even if a client types `localhost` by itself — which
 * is perfectly legitimate — it must find someone listening.
 */
test('a loopback bind listens on both families', () => {
  assert.deepEqual(listenHostsFor('127.0.0.1'), ['127.0.0.1', '::1']);
  assert.deepEqual(listenHostsFor('localhost'), ['127.0.0.1', '::1']);
  // The address asked for stays the main one: it is the one that must fail loudly.
  assert.deepEqual(listenHostsFor('::1'), ['::1', '127.0.0.1']);
});

test('a public listen is not turned into a dual stack', () => {
  // `0.0.0.0` and a machine IP are exposure decisions: widening
  // them to `::` would publish the UI on interfaces nobody asked for.
  assert.deepEqual(listenHostsFor('0.0.0.0'), ['0.0.0.0']);
  assert.deepEqual(listenHostsFor('192.168.1.10'), ['192.168.1.10']);
  assert.equal(isLoopbackHost('0.0.0.0'), false);
  assert.equal(isLoopbackHost('LOCALHOST'), true);
});
