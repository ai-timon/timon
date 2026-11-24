// french-ok-file: the French briefs and closing comments agents really send
import assert from 'node:assert/strict';
import test from 'node:test';
import { promptParts, renderPromptSegments, renderPromptText } from './prompt-presentation';
import { setLocale } from './i18n';
import './i18n-test-locales';

const prefix = 'Mission return — delivered INTO THIS mission because it is the one that\n'
  + 'started the work. Process each return, then continue the rest of your plan\nor close the project.\n\n';

test('runtime instructions are collapsed and the actual response stays outside the details', () => {
  const parts = [{ kind: 'instruction', text: prefix }, { kind: 'text', text: 'All clear.' }];
  const origin = { kind: 'agent', presentation: { version: 1, parts } };
  assert.deepEqual(promptParts(prefix + 'All clear.', origin), parts);
  setLocale('en');
  const html = renderPromptText(prefix + 'All clear.', origin);
  assert.match(html, /<details class="automatic-instruction tool-block">/);
  assert.match(html, /Automated instruction/);
  assert.match(html, /<svg[^>]*class="lucide lucide-bot size-3.5 shrink-0"[^>]*aria-hidden="true"/);
  assert.doesNotMatch(html, /🤖/);
  assert.match(html, /<\/details><p>All clear\.<\/p>/);
  assert.doesNotMatch(html, /<details[^>]*\bopen\b/);
  assert.doesNotMatch(/<summary[^>]*>(.*?)<\/summary>/.exec(html)![1]!, /Mission return/);
  setLocale('fr');
  assert.match(renderPromptText(prefix + 'All clear.', origin), /Instruction automatique/);
  setLocale('en');
});

test('missing, invalid and mismatched metadata never drops or collapses human content', () => {
  const text = prefix + 'An example supplied by the user';
  for (const origin of [undefined, null, {}, { kind: 'human' },
    { presentation: { version: 2, parts: [] } },
    { presentation: { version: 1, parts: [{ kind: 'instruction', text: 'Different text' }] } },
    { presentation: { version: 1, parts: [null] } },
  ]) assert.deepEqual(promptParts(text, origin), [{ kind: 'text', text }]);
});

test('old wake messages use an anchored fallback without changing the reply', () => {
  const parts = promptParts(prefix + 'Reply containing TASK_ID: abc12345', { kind: 'agent' });
  assert.equal(parts[0]!.kind, 'instruction');
  assert.equal(parts[1]!.kind, 'text');
  assert.equal(parts.map((part) => part.text).join(''), prefix + 'Reply containing TASK_ID: abc12345');
  assert.equal(promptParts('Quoted: ' + prefix, { kind: 'agent' }).length, 1);
});

test('old Kanban prompts retain the brief between generated preamble and pipeline', () => {
  const text = 'TASK_ID: abcdef12-1234\n\nFix the chat\n\nKeep errors visible.'
    + '\n\n---\nPIPELINE : `code-group`. Runtime directive';
  const parts = promptParts(text, { kind: 'dispatcher' });
  assert.deepEqual(parts.map((part) => part.kind), ['instruction', 'text', 'instruction']);
  assert.equal(parts[1]!.text, 'Fix the chat\n\nKeep errors visible.');
  assert.equal(parts.map((part) => part.text).join(''), text);
  assert.deepEqual(promptParts(text), [{ kind: 'text', text }]);
});

test('Kanban prompts written in English (#628) fold the same runtime directives', () => {
  for (const directive of [
    '\n\n---\nPIPELINE: `code-self`. Create NO `review` or `merge` task',
    '\n\n## Conflicts to resolve BEFORE anything else\n\nResolve them.',
    '\n\n## Where you merge — hard rule\n\nIn your worktree.',
    '\n\n_Note: your branch was automatically brought up to date with `main`._',
  ]) {
    const text = 'TASK_ID: abcdef12-1234\n\nFix the chat' + directive;
    const parts = promptParts(text, { kind: 'dispatcher' });
    assert.deepEqual(parts.map((part) => part.kind), ['instruction', 'text', 'instruction']);
    assert.equal(parts[1]!.text, 'Fix the chat');
    assert.equal(parts.map((part) => part.text).join(''), text);
  }
});

test('both visible and collapsed markdown remain sanitized', () => {
  const text = '<img src=x onerror="alert(1)"><script>alert(1)</script>';
  const html = renderPromptText(text, { presentation: { version: 1, parts: [{ kind: 'instruction', text }] } });
  assert.doesNotMatch(html, /onerror|<script/);
});

test('an authored label titles the collapsed block, a malformed one falls back', () => {
  setLocale('en');
  const summaryOf = (origin: unknown) => /<summary[^>]*>(.*?)<\/summary>/.exec(renderPromptText(prefix, origin))![1]!;
  const labelled = { presentation: { version: 1, parts: [
    { kind: 'instruction', text: prefix, label: 'taskDone' }] } };
  assert.match(summaryOf(labelled), /Task completed/);
  // A label is a short i18n key, not the return header. Unknown keys are shown
  // verbatim so messages stored before the keys existed stay readable.
  const legacy = { presentation: { version: 1, parts: [
    { kind: 'instruction', text: prefix, label: 'timon.merger — [merge] DONE : Palette <Add widgets>' }] } };
  const summary = summaryOf(legacy);
  assert.match(summary, /timon\.merger — \[merge\] DONE : Palette &lt;Add widgets&gt;/);
  assert.doesNotMatch(summary, /Automated instruction|<Add/);
  for (const label of [42, '  ']) {
    const bad = { presentation: { version: 1, parts: [{ kind: 'instruction', text: prefix, label }] } };
    assert.deepEqual(promptParts(prefix, bad), [{ kind: 'instruction', text: prefix }]);
    assert.match(renderPromptText(prefix, bad), /Automated instruction/);
  }
});

test('a slash expansion folds the inlined skill and keeps the human request visible', () => {
  setLocale('en');
  // Verbatim shape of what `orchestrator/src/slash.ts` composes. The parts
  // must re-concatenate into the sent text or `promptParts` bails to plain —
  // the invariant that silently un-folds every skill bubble if it drifts.
  const procedure = '[Skill invoqué explicitement : `geo`] Applique…\n\n<skill id="geo">\nlong body\n</skill>\n\n---\n\n';
  const request = 'Ma demande : audite ce site.';
  const origin = { presentation: { version: 1, parts: [
    { kind: 'instruction', text: procedure, label: 'skillInvoked', labelVars: { id: 'geo' } },
    { kind: 'text', text: request },
  ] } };
  const html = renderPromptText(procedure + request, origin);
  assert.equal(/<summary[^>]*>(.*?)<\/summary>/.exec(html)![1]!.includes('Skill /geo'), true);
  assert.match(html, /<\/details><p>Ma demande : audite ce site\.<\/p>/);
  assert.doesNotMatch(html.replace(/<details[\s\S]*<\/details>/, ''), /long body/);
  setLocale('fr');
  assert.match(renderPromptText(procedure + request, origin), /Skill \/geo/);
  setLocale('en');
});

test('a malformed label var bag is dropped, never the block it titles', () => {
  setLocale('en');
  const parts = [{ kind: 'instruction', text: prefix, label: 'skillInvoked', labelVars: { id: 42 } }];
  const html = renderPromptText(prefix, { presentation: { version: 1, parts } });
  assert.match(html, /Skill \/\{id\}/);
  assert.match(html, /Mission return/);
});

/** A two-return digest as the daemon writes it (wake-digest.ts). */
function digest() {
  const preamble = 'Mission return — preamble\n\n';
  const h1 = '── Message 1 (de `p.coder`) — [code] DONE : Volet A ──\n';
  const b1 = 'Commentaire de clôture :\n{ "findings": [] }\nportabilité : n/a\n';
  const h2 = '── Message 2 (de `p.reviewer`) — [review] DONE : Review A ──\n';
  const b2 = 'Verdict : changes_requested';
  const parts = [
    { kind: 'instruction', text: preamble },
    { kind: 'instruction', label: 'taskDone', text: h1, segment: 0 },
    { kind: 'text', text: b1, segment: 0 },
    { kind: 'instruction', label: 'taskDone', text: h2, segment: 1 },
    { kind: 'text', text: b2, segment: 1 },
  ];
  const segments = [
    { from: 'p.coder', at: 1_000, mission_id: 'm-1', card: {
      task_id: 'aaaaaaaa-1', title: 'Volet A', type: 'code', status: 'DONE', summary: 'Le bouton **Exporter** marche.',
      merged_sha: 'abcdef1234567890', todo_closed: [198],
      todo_progress: [{ id: 461, progress: 'partial', landed: 1, total: 7 }, { id: 12, progress: 'analyzed', landed: 'x' }] } },
    { from: 'p.reviewer', at: 2_000, mission_id: null, card: {
      task_id: 'bbbbbbbb-2', title: 'Review A', type: 'review', status: 'DONE', verdict: 'changes_requested',
      findings: '- Le focus clavier se perd.' } },
  ];
  return { text: preamble + h1 + b1 + h2 + b2, origin: { kind: 'task_return', from: 'orchestrator-wake', presentation: { version: 1, parts, segments } } };
}

test('a digest splits into one bubble per return, under its own sender and time', () => {
  setLocale('en');
  const { text, origin } = digest();
  const views = renderPromptSegments(text, origin)!;
  assert.deepEqual(views.map((v) => [v.from, v.at, v.missionId]), [['p.coder', 1_000, 'm-1'], ['p.reviewer', 2_000, null]]);
  const [coder, reviewer] = views as [typeof views[0], typeof views[0]];
  // Visible: title, outcome, summary, chips. Folded: everything written for the pilot.
  const visible = (html: string) => html.replace(/<details[\s\S]*<\/details>/, '');
  assert.match(visible(coder.html), /Volet A/);
  assert.match(visible(coder.html), /<strong>Exporter<\/strong>/);
  assert.match(visible(coder.html), /merged abcdef1/);
  assert.match(visible(coder.html), /#198 closed/);
  assert.match(visible(coder.html), /#461: 1\/7 chains landed/);
  assert.match(visible(coder.html), /#12 → analyzed/, 'a malformed count falls back to the plain move');
  assert.doesNotMatch(visible(coder.html), /findings|portabilité|Commentaire de clôture|Mission return/);
  assert.match(coder.html, /<details class="automatic-instruction tool-block return-card-details">/);
  assert.match(coder.html, /Mission return — preamble/, 'the preamble is folded into the first bubble, not dropped');
  assert.match(visible(reviewer.html), /Changes requested/);
  assert.match(visible(reviewer.html), /Le focus clavier se perd/, 'findings that call a decision stay visible');
});

test('history and malformed segments fall back to the single-message rendering', () => {
  const { text, origin } = digest();
  assert.equal(renderPromptSegments(text, undefined), null);
  assert.equal(renderPromptSegments(text, { ...origin, presentation: { ...origin.presentation, segments: undefined } }), null);
  for (const segments of [[], [{ from: '', at: 1 }], [{ from: 'a', at: 'now' }], [null],
    [{ from: 'p.coder', at: 1 }]]) { // part index 1 out of range
    assert.equal(renderPromptSegments(text, { ...origin, presentation: { ...origin.presentation, segments } }), null);
  }
  // Text that does not match the parts: promptParts falls back, so does the split.
  assert.equal(renderPromptSegments(text + ' edited', origin), null);
});

test('every card field is escaped or sanitized', () => {
  const { text, origin } = digest();
  const evil = '<img src=x onerror=alert(1)>';
  const segments = origin.presentation.segments.map((s) => ({
    ...s, from: s.from, card: { ...s.card, title: evil, type: evil, merged_sha: evil, summary: evil, blocked_reason: evil, findings: evil },
  }));
  for (const view of renderPromptSegments(text, { ...origin, presentation: { ...origin.presentation, segments } })!) {
    assert.doesNotMatch(view.html, /<img[^>]*onerror/i);
  }
});

test('an agent message without a card keeps its header folded and its body visible', () => {
  const header = '── Message 1 (de `p.lib`) — note ──\n';
  const parts = [{ kind: 'instruction', label: 'agentMessage', text: header, segment: 0 }, { kind: 'text', text: 'Bonjour', segment: 0 }];
  const views = renderPromptSegments(header + 'Bonjour', {
    kind: 'agent', from: 'p.lib', presentation: { version: 1, parts, segments: [{ from: 'p.lib', at: 5 }] },
  })!;
  assert.equal(views.length, 1);
  assert.match(views[0]!.html, /<details class="automatic-instruction tool-block">/);
  assert.match(views[0]!.html, /<\/details><p>Bonjour<\/p>/);
});

test('adjacent instruction parts share one fold, titled by the first label', () => {
  setLocale('en');
  const parts = [{ kind: 'instruction', text: 'a\n\n' }, { kind: 'instruction', text: 'b', label: 'agentMessage' }];
  const html = renderPromptText('a\n\nb', { kind: 'agent', presentation: { version: 1, parts } });
  assert.equal(html.match(/<details/g)?.length, 1);
  assert.match(html, /Agent message/);
});

test('a blocked return reads its coded reason in the reader\'s language', () => {
  const { text, origin } = digest();
  const reason = 'Stopped by rom (timon stop agent worker)';
  const segments = origin.presentation.segments.map((s) => ({
    ...s, card: { ...s.card, status: 'BLOCKED', blocked_reason: reason,
      blocked_reason_code: { code: 'task_stopped_by_scope', params: { by: 'rom', kind: 'agent', name: 'worker' } } },
  }));
  setLocale('fr');
  try {
    const [first] = renderPromptSegments(text, { ...origin, presentation: { ...origin.presentation, segments } })!;
    assert.match(first!.html, /Arrêtée par rom \(timon stop agent worker\)/);
  } finally {
    setLocale('en');
  }
});
