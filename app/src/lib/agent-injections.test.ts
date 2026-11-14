/**
 * Where an edit of an injection is written: each kind of block goes through the
 * route that already owns its source — an agent file, the agent config, a role,
 * a memory rule, a skill — and never into a copy held by the view.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTokens, freshConversationAgents, maskingNotice, neverReadSkills, parseSkillReads, saveRequest, skillReadState, tokensByOrigin, whyNotEditable } from './agent-injections';

test('an agent file is written as text/plain through the files route', () => {
  const req = saveRequest({ kind: 'agent_file', agent: 'timon.coder', path: 'system-prompt.md' }, '# new\n');
  assert.equal(req.method, 'PUT');
  assert.equal(req.url, '/api/ui/agents/timon.coder/files?path=system-prompt.md');
  assert.match(req.headers['content-type']!, /^text\/plain/);
  assert.equal(req.body, '# new\n');
});

test('the other sources are written through their own route, as JSON', () => {
  const cfg = saveRequest({ kind: 'agent_config', agent: 'a b', field: 'directives' }, 'be brief');
  assert.equal(cfg.method, 'PATCH');
  assert.equal(cfg.url, '/api/ui/agents/a%20b/config');
  assert.deepEqual(JSON.parse(cfg.body), { directives: 'be brief' });

  const role = saveRequest({ kind: 'agent_role', role_id: 'coder' }, 'code well');
  assert.equal(role.method, 'PUT');
  assert.equal(role.url, '/api/ui/agent-roles/coder');
  assert.deepEqual(JSON.parse(role.body), { default_directives: 'code well' });

  const rule = saveRequest({ kind: 'memory_rule', rule_id: 42 }, 'never do X');
  assert.equal(rule.method, 'PATCH');
  assert.equal(rule.url, '/api/ui/memory/rules/42');
  assert.deepEqual(JSON.parse(rule.body), { text: 'never do X' });

  const skill = saveRequest({ kind: 'skill', skill_id: 'timon-task' }, '---\nname: x\n---\nbody');
  assert.equal(skill.method, 'POST');
  assert.equal(skill.url, '/api/ui/skills');
  assert.deepEqual(JSON.parse(skill.body), { id: 'timon-task', content: '---\nname: x\n---\nbody' });
});

test('the reason a block is read-only is the masked secret first, then who reads it', () => {
  const base = { editable: false, redacted: false, injected_by: 'timon' as const, items: [] };
  assert.equal(whyNotEditable({ ...base, editable: true }), null);
  assert.equal(whyNotEditable({ ...base, redacted: true }), 'redacted');
  assert.equal(whyNotEditable({ ...base, injected_by: 'cli' }), 'cli');
  assert.equal(whyNotEditable(base), 'code');
});

test('the notice of a masked block says what the agent receives', () => {
  const base = { redacted: true, injected_by: 'timon' as const };
  assert.equal(maskingNotice({ ...base, redacted: false }), null);
  assert.equal(maskingNotice(base), 'shown', 'a daemon that does not say it masks only the view');
  assert.equal(maskingNotice({ ...base, sent_masked: false }), 'shown');
  assert.equal(maskingNotice({ ...base, sent_masked: true }), 'sent');
  assert.equal(maskingNotice({ ...base, injected_by: 'cli' }), 'cli');
});

test('a token count is short enough for a badge', () => {
  assert.equal(formatTokens(850), '850');
  assert.equal(formatTokens(1200), '1.2k');
  assert.equal(formatTokens(2000), '2k');
  assert.equal(formatTokens(21400), '21k');
});

test('tokens are summed per origin, heaviest first, without the files the CLI may read', () => {
  const totals = tokensByOrigin([
    { origin: 'timon', tokens: 8000, injected_by: 'timon' },
    { origin: 'skills', tokens: 10000, injected_by: 'timon' },
    { origin: 'timon', tokens: 200, injected_by: 'timon' },
    { origin: 'project', tokens: 1000, injected_by: 'cli' },
  ]);
  assert.deepEqual(totals, [{ origin: 'skills', tokens: 10000 }, { origin: 'timon', tokens: 8200 }]);
});

test('skill reads: a malformed answer is null, bad entries are dropped', () => {
  assert.equal(parseSkillReads({ ok: true }), null);
  assert.equal(parseSkillReads(null), null);
  assert.deepEqual(
    parseSkillReads({ window_days: 30, missions: 4, skills: { a: { reads: 2, missions: 1 }, b: { reads: 'x' } } }),
    // An older daemon does not send the field: every mission counts as measured.
    { window_days: 30, missions: 4, unmeasured_missions: 0, skills: { a: { reads: 2, missions: 1 } } },
  );
  assert.equal(parseSkillReads({ window_days: 30, missions: 4, unmeasured_missions: 3, skills: {} })?.unmeasured_missions, 3);
  assert.equal(parseSkillReads({ window_days: 30, missions: 4, unmeasured_missions: 'x', skills: {} })?.unmeasured_missions, 0);
});

test('skill reads: a backend without skill_get never makes a skill "never read"', () => {
  const item = { id: 's', label: 'cold', content: '', tokens: 1, source_path: null, editable: false, editable_text: null, edit_target: null, skill_mode: 'include' as const };
  const all = { window_days: 30, missions: 5, unmeasured_missions: 5, skills: { seen: { reads: 2, missions: 1 } } };
  assert.deepEqual(skillReadState(all, 'cold'), { kind: 'unmeasured', days: 30 });
  assert.deepEqual(neverReadSkills({ items: [item] }, all), []);
  // A read seen is a read, wherever it ran.
  assert.deepEqual(skillReadState(all, 'seen'), { kind: 'read', reads: 2, missions: 1, total: 5, days: 30 });
  // Mixed: the verdict rests on the missions that could have been seen, and says how many.
  const mixed = { ...all, unmeasured_missions: 2 };
  assert.deepEqual(skillReadState(mixed, 'cold'), { kind: 'never', total: 3, days: 30 });
  assert.deepEqual(neverReadSkills({ items: [item] }, mixed), ['cold']);
});

test('skill reads: never read only when missions ran, and only for catalogue skills', () => {
  const reads = { window_days: 30, missions: 5, unmeasured_missions: 0, skills: { read: { reads: 3, missions: 2 } } };
  assert.deepEqual(skillReadState(reads, 'read'), { kind: 'read', reads: 3, missions: 2, total: 5, days: 30 });
  assert.deepEqual(skillReadState(reads, 'cold'), { kind: 'never', total: 5, days: 30 });
  assert.deepEqual(skillReadState({ ...reads, missions: 0 }, 'cold'), { kind: 'idle', days: 30 });
  const item = (label: string, skill_mode: 'include' | 'import') => ({
    id: `skill-${label}`, label, content: '', tokens: 1, source_path: null, editable: false, editable_text: null, edit_target: null, skill_mode,
  });
  const block = { items: [item('read', 'include'), item('cold', 'include'), item('pasted', 'import')] };
  // An imported body is always in the prompt: it is never "not read".
  assert.deepEqual(neverReadSkills(block, reads), ['cold']);
  assert.deepEqual(neverReadSkills(block, null), []);
});

test('a rule edit names the agents sent to a fresh conversation, anything else names none', () => {
  assert.deepEqual(freshConversationAgents({ id: 3, text: 'x', fresh_conversation: ['coder', 7, 'lead'] }), ['coder', 'lead']);
  assert.deepEqual(freshConversationAgents({ id: 3, text: 'x' }), []);
  assert.deepEqual(freshConversationAgents({ fresh_conversation: 'coder' }), []);
  assert.deepEqual(freshConversationAgents(null), []);
});
