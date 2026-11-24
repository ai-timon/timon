/**
 * The `question` form as the user meets it: one tab per question, Next until
 * the last one and Send there, a question held until it has a pick or text,
 * the free text inside its own question's answer, the badge saying who acts,
 * and a card decided before this form existed still readable.
 */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { AskAnswerValue, AskUserQuestion } from '@/lib/ask-user-answers';
import type { AskFormState } from './ask-user-form';

const BRANCH: AskUserQuestion = {
  question: 'Which branch?',
  header: 'Branch',
  options: [
    { label: 'Switch the repository to main', actor: 'agent' },
    { label: 'Switch it myself', actor: 'user' },
    { label: 'Leave it', actor: 'Somebody' as never },
  ],
};
const CHECKS: AskUserQuestion = { question: 'Which checks?', multiSelect: true, options: [{ label: 'lint' }, { label: 'types' }] };

async function mount(ctx: TestContext, questions: AskUserQuestion[], state: AskFormState = 'pending') {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/chat', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    if (!saved.has(key)) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent']) {
    install(key, key === 'window' ? dom.window : Reflect.get(dom.window, key));
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { AskUserForm } = await import('./ask-user-form');
  const { buildAskAnswers } = await import('@/lib/ask-user-answers');
  const submitted: Record<string, AskAnswerValue>[] = [];

  function Harness() {
    const [picks, setPicks] = React.useState<Record<string, string | string[]>>(
      () => Object.fromEntries(questions.map((q) => [q.question, q.multiSelect ? [] : ''])),
    );
    const [custom, setCustom] = React.useState<Record<string, string>>({});
    return React.createElement(AskUserForm, {
      questions, picks, setPicks, custom, setCustom, state, busy: false,
      onSubmit: () => { submitted.push(buildAskAnswers(questions, picks, custom)); },
      onCancel: () => {},
    });
  }

  const root = createRoot(document.getElementById('root')!);
  const act = (fn: () => void | Promise<void>) => React.act(async () => { await fn(); });
  await act(() => root.render(React.createElement(Harness)));
  ctx.after(async () => {
    await act(() => root.unmount());
    dom.window.close();
    for (const [key, d] of saved) { if (d) Object.defineProperty(globalThis, key, d); else Reflect.deleteProperty(globalThis, key); }
  });

  const tabs = () => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
  const action = () => document.querySelector<HTMLButtonElement>('[data-ask-action]');
  const option = (label: string) => Array.from(document.querySelectorAll('label')).find((l) => l.textContent?.includes(label))!
    .querySelector('input')!;
  const type = (el: HTMLInputElement | HTMLTextAreaElement, value: string) => act(() => {
    const proto = el instanceof dom.window.HTMLTextAreaElement ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  const click = (el: HTMLElement) => act(() => { el.click(); });
  return { tabs, action, option, type, click, submitted, text: () => document.body.textContent ?? '' };
}

test('one tab per question: Next until the last one, Send there, the tabs lead back', async (ctx) => {
  const f = await mount(ctx, [BRANCH, CHECKS]);
  assert.deepEqual(f.tabs().map((b) => b.textContent), ['Branch', 'Question 2'], 'a question without header gets a numbered tab');
  assert.equal(f.tabs()[0]!.getAttribute('aria-selected'), 'true');
  assert.equal(f.tabs()[1]!.disabled, true, 'no skipping past an unanswered question');
  assert.equal(f.action()!.dataset.askAction, 'next');
  assert.equal(f.action()!.disabled, true, 'nothing ticked, no text: no Next');

  await f.click(f.option('Switch it myself'));
  assert.equal(f.action()!.disabled, false);
  await f.click(f.action()!);
  assert.equal(f.tabs()[1]!.getAttribute('aria-selected'), 'true');
  assert.equal(f.action()!.dataset.askAction, 'submit');
  assert.equal(f.action()!.textContent, 'Send reply');
  assert.equal(f.action()!.disabled, true);

  await f.click(f.tabs()[0]!);
  assert.equal(f.tabs()[0]!.getAttribute('aria-selected'), 'true', 'a tab takes the user back');
  assert.equal(f.option('Switch it myself').checked, true, 'the pick survives the round trip');
  await f.click(f.tabs()[1]!);

  await f.type(document.querySelector('textarea')!, 'none, CI runs them');
  assert.equal(f.action()!.disabled, false, 'the text alone answers the question');
  await f.click(f.action()!);
  assert.deepEqual(f.submitted, [{ 'Which branch?': 'Switch it myself', 'Which checks?': { text: 'none, CI runs them' } }]);
});

test('a second click unticks a radio, and the free text joins that question\'s answer', async (ctx) => {
  const f = await mount(ctx, [BRANCH]);
  assert.equal(f.tabs().length, 0, 'a single question needs no tabs');
  assert.equal(f.action()!.dataset.askAction, 'submit');
  await f.click(f.option('Leave it'));
  assert.equal(f.option('Leave it').checked, true);
  await f.click(f.option('Leave it'));
  assert.equal(f.option('Leave it').checked, false);
  assert.equal(f.action()!.disabled, true);

  await f.click(f.option('Switch the repository to main'));
  await f.type(document.querySelector('textarea')!, ' after the demo ');
  await f.click(f.action()!);
  assert.deepEqual(f.submitted, [{ 'Which branch?': { choice: 'Switch the repository to main', text: 'after the demo' } }]);
});

test('the badge says who acts; an unknown actor shows none', async (ctx) => {
  const f = await mount(ctx, [BRANCH]);
  const badges = Array.from(document.querySelectorAll<HTMLElement>('[data-actor]'));
  assert.deepEqual(badges.map((b) => [b.dataset.actor, b.textContent]), [['agent', 'Agent'], ['user', 'You']]);
  assert.match(f.option('Switch the repository to main').closest('label')!.textContent ?? '', /^Agent/);
  assert.ok(!f.option('Leave it').closest('label')!.querySelector('[data-actor]'));
});

test('no "Other" option and no global note any more', async (ctx) => {
  const f = await mount(ctx, [BRANCH]);
  assert.doesNotMatch(f.text(), /Other|Note \(optional\)/);
  assert.equal(document.querySelectorAll('textarea').length, 1, 'one free-text field, the question\'s own');
});

test('an open question keeps its single field, mandatory, and Enter moves on', async (ctx) => {
  const f = await mount(ctx, [{ question: 'Name?', header: 'Name', placeholder: 'assistant.mails' }, BRANCH]);
  const field = document.querySelector<HTMLInputElement>('input[type="text"]')!;
  assert.equal(field.placeholder, 'assistant.mails');
  assert.equal(f.action()!.disabled, true);
  await f.type(field, 'mails');
  await ctxAct(() => field.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  assert.equal(f.tabs()[1]!.getAttribute('aria-selected'), 'true');
});

test('a card decided before this form existed still reads: no header, no actor, no buttons', async (ctx) => {
  // The answer of such a card (with its global `note`) lives in the event, not
  // in the form: the card renders from the questions alone.
  const f = await mount(ctx, [{ question: 'Old one?', options: [{ label: 'a' }, { label: 'b' }] }, { question: 'Old two?' }], 'allowed');
  assert.deepEqual(f.tabs().map((b) => [b.textContent, b.disabled]), [['Question 1', false], ['Question 2', false]]);
  assert.ok(!f.action(), 'a decided card has no buttons');
  assert.match(f.text(), /answered/);
  await f.click(f.tabs()[1]!);
  assert.match(f.text(), /Old two\?/);
});

async function ctxAct(fn: () => void) {
  const React = await import('react');
  await React.act(async () => { fn(); });
}

/** The plan card as the daemon opens it (`cards.approvePlan`, `askUserInput`). */
const PLAN: AskUserQuestion = {
  question: 'Refactor\n\n1. look\n2. change',
  header: 'Plan',
  headerKey: 'askCard.planHeader',
  options: [
    { label: 'Approve the plan', labelKey: 'askCard.planApprove', description: 'The agent carries it out.', descriptionKey: 'askCard.planApproveDescription' },
    { label: 'Reject the plan', labelKey: 'askCard.planReject', description: 'The agent does not; say why in the field below.', descriptionKey: 'askCard.planRejectDescription' },
  ],
};

async function inFrench(ctx: TestContext) {
  const { setLocale } = await import('@/lib/i18n');
  await import('@/lib/i18n-test-locales');
  setLocale('fr');
  ctx.after(() => setLocale('en'));
}

test('the plan card speaks the person\'s language, and the agent still reads its own label back', async (ctx) => {
  await inFrench(ctx);
  const f = await mount(ctx, [PLAN]);
  assert.match(f.text(), /Approuver le plan/);
  assert.match(f.text(), /Rejeter le plan/);
  assert.match(f.text(), /L'agent l'exécute\./); // french-ok: the French locale under test
  assert.doesNotMatch(f.text(), /Approve the plan|Reject the plan|carries it out/);
  assert.match(f.text(), /Refactor/, 'the plan itself is the agent\'s: shown as written');
  await f.click(f.option('Rejeter le plan'));
  await f.type(document.querySelector('textarea')!, 'pas maintenant');
  await f.click(f.action()!);
  assert.deepEqual(f.submitted, [{ [PLAN.question]: { choice: 'Reject the plan', text: 'pas maintenant' } }]);
});

test('a key that does not name the very text shown is ignored: an agent cannot dress one choice as another', async (ctx) => {
  await inFrench(ctx);
  const f = await mount(ctx, [{
    question: 'Proceed?',
    header: 'Deploy',
    headerKey: 'askCard.planHeader',
    options: [
      // Forged: the person would tick "Approuver le plan" while the agent reads "Delete production".
      { label: 'Delete production', labelKey: 'askCard.planApprove' },
      // A key outside the card's own words, even one whose English matches.
      { label: 'Cancel', labelKey: 'common.cancel', description: 'Approve the plan', descriptionKey: 'askCard.planReject' },
    ],
  }]);
  const shown = Array.from(document.querySelectorAll('label')).map((l) => l.textContent);
  assert.deepEqual(shown, ['Delete production', 'CancelApprove the plan']);
  assert.match(f.text(), /Deploy/);
  assert.doesNotMatch(f.text(), /Approuver le plan|Rejeter le plan/);
});
