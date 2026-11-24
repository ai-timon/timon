/**
 * The seal of a launch: references for what a plugin must not hold, swapped back
 * where the data leaves for the agent's process.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

const { LaunchSeal, openLaunchSeal, sealFor, closeLaunchSeal } = await import('./launch-seal.js');
const { sealMissionToken } = await import('./mission-token-seal.js');

test('a value gets one reference, and the reference is worthless on its own', () => {
  const seal = new LaunchSeal('m', 'b', null);
  const a = seal.protect('s3cret-value');
  assert.equal(seal.protect('s3cret-value'), a);
  assert.notEqual(seal.protect('other'), a);
  assert.match(a, /^timon-seal-[0-9a-f]{32}$/);
  assert.equal(a.includes('s3cret'), false);
  // Another launch does not know it.
  assert.equal(new LaunchSeal('m2', 'b', null).swap(`x ${a} y`), `x ${a} y`);
});

test('swap puts the value back, raw or as the inside of a JSON string', () => {
  const seal = new LaunchSeal('m', 'b', null);
  const ref = seal.protect('a"b\\c');
  assert.equal(seal.swap(`k=${ref}`), 'k=a"b\\c');
  assert.equal(JSON.parse(`{"k":"${seal.swap(ref, 'json')}"}`).k, 'a"b\\c');
});

test('a lazy value is issued once, at first use, and never before', () => {
  let issued = 0;
  const seal = openLaunchSeal('m-lazy', 'b', {} as never, () => { issued += 1; return 'tok-1'; });
  assert.equal(issued, 0);
  assert.equal(seal.has(seal.tokenRef()!), true);
  assert.equal(issued, 0, 'asking whether a reference is there does not issue');
  assert.equal(seal.swap(seal.tokenRef()!), 'tok-1');
  assert.equal(seal.token(), 'tok-1');
  assert.equal(issued, 1);
  closeLaunchSeal(seal);
  assert.equal(sealFor('m-lazy'), undefined);
});

test('a seal that is not the live one does not close the live one', () => {
  const first = openLaunchSeal('m-twice', 'b', {} as never, () => 't1');
  const second = openLaunchSeal('m-twice', 'b', {} as never, () => 't2');
  closeLaunchSeal(first);
  assert.equal(sealFor('m-twice'), second);
  closeLaunchSeal(second);
});

test('on a pipe, several references cut across writes are all swapped, other bytes untouched', async () => {
  const seal = new LaunchSeal('m', 'b', null);
  const a = seal.protect('first"value');
  const b = seal.protect('second-value');
  const real = new PassThrough();
  const sealed = sealMissionToken({ stdin: real, stdout: new PassThrough() }, { TIMON_API_TOKEN: 'mission-token' }, seal);
  let out = '';
  real.on('data', (c: Buffer) => { out += c.toString('utf8'); });
  const line = `{"a":"${a}","b":"é${b}","t":"${sealed.mcpEnv.TIMON_API_TOKEN}"}\n`; // french-ok: a two-byte letter the cut positions split
  for (const cut of [10, 25, 61]) {
    // Re-split the same line differently each time: a boundary may fall inside any reference.
    out = '';
    await new Promise<void>((resolve) => sealed.io.stdin.write(line.slice(0, cut), () => resolve()));
    await new Promise<void>((resolve) => sealed.io.stdin.write(line.slice(cut), () => resolve()));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(JSON.parse(out.trim()), { a: 'first"value', b: 'ésecond-value', t: 'mission-token' }); // french-ok: a two-byte letter the cut positions split
  }
});
