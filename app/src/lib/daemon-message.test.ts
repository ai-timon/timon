/**
 * Stored daemon sentences on screen (TODO #845): a code the dictionary knows
 * reads in the reader's language; anything else keeps the stored English.
  *
  * french-ok-file: the French locale of the stored sentences under test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './i18n-test-locales';
import { getLocale, setLocale } from './i18n';
import { daemonMessageText, daemonNotificationText, parseDaemonMessage } from './api-error';
import { localizedNoticePayload } from './daemon-notice-payload';
import { systemNotificationText } from './system-notifications';

function inLocale<T>(tag: string, run: () => T): T {
  const before = getLocale();
  setLocale(tag);
  try { return run(); } finally { setLocale(before); }
}

const ENGLISH = 'Merge guard: DONE is rejected without merged_commit_sha (stored English).';
const MERGE = JSON.stringify({ code: 'merge_sha_abbreviated', params: { guard: 'merge', short: 'fe2dd84' } });

test('a stored code reads in French, its params interpolated', () => {
  const text = inLocale('fr', () => daemonMessageText(MERGE, ENGLISH));
  assert.match(text, /^Garde de merge/);
  assert.match(text, /git rev-parse fe2dd84/);
});

test('without a code, the stored English is shown as it is', () => {
  assert.equal(inLocale('fr', () => daemonMessageText(null, ENGLISH)), ENGLISH);
  assert.equal(inLocale('fr', () => daemonMessageText('not json', ENGLISH)), ENGLISH);
});

test('a code nobody knows, or one missing a param, keeps the English rather than raw ICU', () => {
  assert.equal(inLocale('fr', () => daemonMessageText(JSON.stringify({ code: 'never_heard_of', params: {} }), ENGLISH)), ENGLISH);
  assert.equal(inLocale('fr', () => daemonMessageText(JSON.stringify({ code: 'merge_sha_abbreviated', params: { guard: 'merge' } }), ENGLISH)), ENGLISH);
});

test('an interruption reads its cause, its quota window and the retries running out', () => {
  const stored = {
    code: 'task_interrupted',
    params: {
      reason: 'rate_limit', window: 'five_hour', reopens: '04:05', observed: '03:05',
      context: 'none', lastError: 'none', exhausted: 4, taskId: 't1',
    },
  };
  const fr = inLocale('fr', () => daemonMessageText(stored, 'English'));
  assert.match(fr, /limite d’usage du compte atteinte \(five_hour\), le quota rouvre à 04:05/);
  assert.match(fr, /4 morts système d’affilée/);
  assert.match(fr, /timon task update t1 --status PENDING/);
  const en = inLocale('en', () => daemonMessageText({ ...stored, params: { ...stored.params, exhausted: 0, reason: 'killed' } }, 'English'));
  assert.match(en, /^Mission interrupted: process killed/);
  assert.doesNotMatch(en, /retries are exhausted/);
});

test('a notification title and body each fall back to their own English', () => {
  const english = { title: 'Backend codex: signed out — log in again', body: 'English body' };
  const stored = JSON.stringify({ code: 'backend_signed_out', params: { backend: 'codex', until: Date.UTC(2026, 10, 17, 3) } });
  const fr = inLocale('fr', () => daemonNotificationText(stored, english));
  assert.equal(fr.title, 'Backend codex : déconnecté — reconnectez-vous');
  assert.match(fr.body ?? '', /Backend écarté jusqu’au/);
  assert.deepEqual(inLocale('fr', () => daemonNotificationText(null, english)), english);
});

test('the notification centre translates a coded card and leaves an agent card alone', () => {
  const coded = systemNotificationText({
    title: 'Backend claude: sidelined by the circuit breaker',
    body: 'English',
    message_code: JSON.stringify({
      code: 'backend_breaker_tripped',
      params: { backend: 'claude', failures: 3, signature: '0 turn', seconds: 9, minutes: 0, until: 0 },
    }),
  });
  assert.equal(inLocale('en', () => coded.title), 'Backend claude: sidelined by the circuit breaker');
  const fr = inLocale('fr', () => systemNotificationText({
    title: 'x', body: 'y',
    message_code: JSON.stringify({
      code: 'backend_breaker_tripped',
      params: { backend: 'claude', failures: 3, signature: '0 turn', seconds: 9, minutes: 5, until: 0 },
    }),
  }));
  assert.equal(fr.title, 'Backend claude : écarté par le disjoncteur');
  assert.match(fr.body ?? '', /Il n’est écarté que 5 min/);
  const agent = { title: 'Deploy done', body: '**ok**' };
  assert.deepEqual(inLocale('fr', () => systemNotificationText(agent)), agent);
});

test('an orchestrator notice payload shows translated, without its code as a field', () => {
  const payload = JSON.stringify({
    kind: 'alert', title: 'Review with no usable verdict: x', body: 'English', task_id: 't1',
    code: 'review_verdict_unusable', params: { title: 'x', taskId: 't1', excerpt: 'none' },
  });
  const shown = JSON.parse(inLocale('fr', () => localizedNoticePayload(payload))) as Record<string, unknown>;
  assert.equal(shown.title, 'Review sans verdict exploitable : x');
  assert.match(String(shown.body), /Le relecteur a écrit : \(vide\)/);
  assert.equal('code' in shown, false);
  assert.equal(shown.task_id, 't1');
  const plain = JSON.stringify({ kind: 'alert', title: 'Hand-written', body: 'b' });
  assert.equal(localizedNoticePayload(plain), plain);
  assert.equal(localizedNoticePayload('free text'), 'free text');
});

test('parseDaemonMessage accepts the column and the object, refuses a bad code', () => {
  assert.deepEqual(parseDaemonMessage(MERGE), { code: 'merge_sha_abbreviated', params: { guard: 'merge', short: 'fe2dd84' } });
  assert.equal(parseDaemonMessage({ code: 'Bad-Code' }), null);
  assert.equal(parseDaemonMessage(null), null);
});

test('a blocked-task card reads its title and the coded reason that is its body', () => {
  const stored = JSON.stringify({
    code: 'task_blocked', params: { title: 'Export', taskId: 'abcd1234' },
    body: { code: 'task_stopped_by_scope', params: { by: 'rom', kind: 'agent', name: 'worker' } },
  });
  const fr = inLocale('fr', () => daemonNotificationText(stored, { title: 'Task blocked: Export', body: 'English reason' }));
  assert.equal(fr.title, 'Task bloquée : Export');
  assert.equal(fr.body, 'Arrêtée par rom (timon stop agent worker)');
  const plain = JSON.stringify({ code: 'task_blocked', params: { title: 'none', taskId: 'abcd1234' } });
  const own = inLocale('fr', () => daemonNotificationText(plain, { title: 'Task blocked (abcd1234)', body: 'I need the key.' }));
  assert.deepEqual(own, { title: 'Task bloquée (abcd1234)', body: 'I need the key.' });
});

test('a task return on the Messages page reads its coded reason, without the code as a field', () => {
  const payload = JSON.stringify({
    kind: 'task_closed', task_id: 't1', task_status: 'BLOCKED',
    blocked_reason: 'Stopped by rom (timon stop agent worker)',
    blocked_reason_code: { code: 'task_stopped_by_scope', params: { by: 'rom', kind: 'agent', name: 'worker' } },
  });
  const shown = JSON.parse(inLocale('fr', () => localizedNoticePayload(payload))) as Record<string, unknown>;
  assert.equal(shown.blocked_reason, 'Arrêtée par rom (timon stop agent worker)');
  assert.equal('blocked_reason_code' in shown, false);
  const agentReason = JSON.stringify({ kind: 'task_closed', blocked_reason: 'I need the key.', blocked_reason_code: null });
  assert.equal((JSON.parse(localizedNoticePayload(agentReason)) as Record<string, unknown>).blocked_reason, 'I need the key.');
});

test('a mission killed for memory reads its process, its ceiling and its advice', () => {
  const stored = JSON.stringify({
    code: 'resource_mission_killed',
    params: { mission: 'abcd1234', cmd: 'node', pid: '4242', ceiling: '4.0 GB', whose: 'mission', rss: 'none' },
  });
  const fr = inLocale('fr', () => daemonNotificationText(stored, { title: 'English', body: 'English' }));
  assert.equal(fr.title, 'OOM : mission abcd1234 — processus tué');
  assert.match(fr.body ?? '', /Votre processus `node` \(pid 4242\) a été tué par le noyau : il utilisait plus de 4\.0 GB de mémoire, le plafond de cette mission\. Relancer/);
  assert.match(fr.body ?? '', /npm test -- <file>/);
});

test('system cards read their branches and counts in French', () => {
  const fr = (code: string, params: Record<string, string | number>) =>
    inLocale('fr', () => daemonNotificationText(JSON.stringify({ code, params }), { title: 'English', body: 'English' }));
  const seat = fr('main_seat_empty', { candidates: 'none' });
  assert.equal(seat.title, 'Aucun orchestrateur principal');
  assert.match(seat.body ?? '', /Aucun orchestrateur sans projet n’existe/);
  const hosts = fr('egress_new_hosts', { count: 3, scopeKind: 'project', scopeName: 'timon', agent: 'p.coder', hosts: 'a.io, b.io', more: 1, missionId: 'm1' });
  assert.equal(hosts.title, '3 nouveaux hôtes sortants pour le projet timon');
  assert.match(hosts.body ?? '', /a\.io, b\.io et 1 autre\(s\)/);
  const permission = fr('permission_required', { tool: 'Bash', agent: 'p.coder', minutes: 0 });
  assert.equal(permission.body, 'L’agent p.coder demande l’autorisation d’utiliser `Bash`.');
  const series = fr('series_fallback_applied', {
    outcome: 'stuck', scope: 'none', series: 'abcd1234', tasks: 2, pilot: 'stuck', backend: 'none',
    failure: 'none', moved: 'none', requeued: 0, trigger: 'none',
  });
  assert.equal(series.title, 'Quota épuisé — tasks basculées, orchestrateur NON déplacé');
  assert.match(series.body ?? '', /ses tasks redémarrent sur des backends de secours/);
});

test('a stored sentence that sends to Settings reads the path the dialog shows now', () => {
  const stored = JSON.stringify({ code: 'device_paired', params: { name: 'Pixel' } });
  const english = { title: 'English', body: 'English' };
  const en = inLocale('en', () => daemonNotificationText(stored, english));
  assert.equal(en.body, '"Pixel" was paired with your account. If this was not you, revoke it in Settings → Access & network → Devices.');
  const fr = inLocale('fr', () => daemonNotificationText(stored, english));
  assert.match(fr.body ?? '', /révoquez-le dans Paramètres → Accès & réseau → Appareils\.$/);
  const launch = inLocale('en', () => daemonNotificationText(
    JSON.stringify({ code: 'backend_launch_unauthorized', params: { backend: 'codex', reason: 'Changed.' } }), english));
  assert.match(launch.body ?? '', /\(Settings → AI models → Providers\)/);
  const replay = inLocale('en', () => daemonNotificationText(
    JSON.stringify({ code: 'integration_gave_up', params: { transport: 'telegram' } }), english));
  assert.match(replay.body ?? '', /Replay it from Settings → Secrets → Connections\.$/);
});

test('a layout proposal card names its kind in French, with its project and note only when present', () => {
  const english = { title: 'Island layout to review: tim', body: 'Plan (site)' };
  const full = { code: 'layout_proposal_to_review', params: { kind: 'island_arrangement', agent: 'tim', mission: 'Plan', project: 'site', note: 'calmer' } };
  assert.deepEqual(inLocale('fr', () => daemonNotificationText(full, english)),
    { title: "Agencement d'îlots à examiner : tim", body: 'Plan (site) — calmer' });
  const bare = { code: 'layout_proposal_to_review', params: { kind: 'widgets', agent: 'plugin:demo', mission: 'Plan', project: 'none', note: 'none' } };
  assert.deepEqual(inLocale('en', () => daemonNotificationText(bare, english)),
    { title: 'Widget arrangement to review: plugin:demo', body: 'Plan' });
});
