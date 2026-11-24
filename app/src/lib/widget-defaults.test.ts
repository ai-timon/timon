import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeWorkspaceWidgets, workspaceWidgets } from '../components/widget-host/widget-defaults';
import type { WidgetConstraints } from '../components/widget-host/widget-layout';
import { MAIN_AGENT_WIDGET_ID } from './main-agent-card';
import { ADD_WIDGET_IDS, isAddWidgetPlaceholder } from '../components/widget-host/add-widget';

/** A catalogue wider than what the starters place: what is NOT shipped on a
 *  view must land in the palette, not on the board. */
const ids = [
  MAIN_AGENT_WIDGET_ID,
  'plugin:@timon/agents:notifications', 'plugin:@timon/agents:tasks', 'plugin:@timon/ui-layout:clock',
  'plugin:@timon/missions:Missions', 'plugin:@timon/workflows:trace', 'plugin:@timon/files-widget:Files',
  'plugin:@timon/kanban:project-todo', 'plugin:@timon/kanban:todo',
  'plugin:@timon/git:branches', 'plugin:@timon/git:graph', 'plugin:@timon/git:publish',
  'plugin:@timon/kanban:pull-requests', 'plugin:@timon/kanban:landings', 'plugin:github-issues:issues',
  ...ADD_WIDGET_IDS,
  'plugin:@timon/docker-supervision:docker', 'plugin:@timon/skills-widget:skills', 'plugin:@timon/mcp-widget:mcp',
  'plugin:@timon/projects:overview', 'plugin:@timon/agents:team', 'plugin:@timon/video-factory:video',
];
const constraints: WidgetConstraints[] = ids.map(id => ({ id, defaultHeight: 260, minHeight: 76, defaultZone: 'gauche', defaultRank: 0 }));

test('a fresh install opens on the short arrangement the product ships (05/11/2026)', () => {
  const [add, add2] = ADD_WIDGET_IDS;
  const cockpit = mergeWorkspaceWidgets(null, constraints, '/').filter(w => !w.removed);
  // The centre of the cockpit is the main agent's chat: that IS the first
  // screen of the product, and a starter that named anything else would give
  // a new install a board with no conversation on it.
  const center = cockpit.find(w => w.rail === 'centre');
  assert.equal(center?.id, MAIN_AGENT_WIDGET_ID);
  assert.equal(center?.heightMode, 'fill');
  const column = (cards: typeof cockpit, rail: string) => cards.filter(w => w.rail === rail).sort((a, b) => a.rang - b.rang);
  const byRail = (rail: string) => column(cockpit, rail).map(w => w.id);
  const shares = (cards: typeof cockpit, rail: string) => column(cards, rail).map(w => w.fillPercent);
  assert.deepEqual(byRail('gauche'), ['plugin:@timon/agents:notifications', add]);
  assert.deepEqual(shares(cockpit, 'gauche'), [66, 34], 'the notifications take two thirds, "Your widget here" the rest');
  assert.deepEqual(byRail('centre'), [MAIN_AGENT_WIDGET_ID]);
  assert.deepEqual(byRail('droite'), ['plugin:@timon/kanban:todo', 'plugin:@timon/agents:tasks']);
  assert.deepEqual(shares(cockpit, 'droite'), [50, 50]);
  // Frameless and transparent: the cockpit's cards sit on the background
  // rather than in boxes; the dashed placeholder draws its own outline.
  assert.ok(cockpit.filter(w => !isAddWidgetPlaceholder(w.id)).every(w => w.borderless && w.transparent));

  const chat = mergeWorkspaceWidgets(null, constraints, '/chat').filter(w => !w.removed);
  const short = (rail: string) => column(chat, rail).map(w => w.id.split(':').at(-1));
  assert.deepEqual(short('chat.left.widget'), ['Missions', 'Files']);
  assert.deepEqual(shares(chat, 'chat.left.widget'), [50, 50]);
  assert.deepEqual(short('chat.right.widget'), ['branches', 'graph', 'publish', 'pull-requests', 'landings', 'issues', 'docker']);
  // The "Git" stack: one card of six tabs, Branches in front, then Docker.
  const stack = column(chat, 'chat.right.widget').filter(w => w.group);
  assert.equal(stack.length, 6);
  assert.equal(new Set(stack.map(w => w.group)).size, 1, 'one stack');
  assert.deepEqual(stack.filter(w => w.activeTab).map(w => short('chat.right.widget')[column(chat, 'chat.right.widget').indexOf(w)]), ['branches']);
  assert.ok(stack.every(w => w.heightMode === 'fill' && w.fillPercent === 66), 'the stack takes two thirds');
  assert.equal(column(chat, 'chat.right.widget').at(-1)?.fillPercent, 34, 'Docker the rest');
  assert.ok(chat.filter(w => w.rail === 'chat.left.widget').every(w => !w.group), 'no stack on the left');

  const canvas = mergeWorkspaceWidgets(null, constraints, '/agents').filter(w => !w.removed);
  assert.deepEqual(canvas.map(w => [w.rail, w.id]).sort(), [['agents.left.widget', add], ['agents.right.widget', add2]].sort(),
    'the agents canvas starts bare: a placeholder per column');
  assert.ok(canvas.every(w => w.heightMode !== 'fill'), 'alone in its column, a placeholder keeps its own height');

  // Nothing shipped places these, on any view.
  for (const gone of ['video-factory', 'clock', 'trace', 'skills', 'mcp', 'project-todo']) {
    assert.ok([...cockpit, ...chat, ...canvas].every(w => !w.id.includes(gone)), gone);
  }
  assert.ok(chat.every(w => w.id !== MAIN_AGENT_WIDGET_ID));
});

test('saved placements survive and new plugins stay in the palette', () => {
  const saved = [{ id: constraints[0]!.id, rail: 'droite', rang: 0, hauteur: 420, transparent: true, untitled: true }];
  const result = mergeWorkspaceWidgets(saved, constraints, '/');
  assert.deepEqual(result.find(w => w.id === saved[0]!.id), saved[0]);
  assert.ok(result.filter(w => w.id !== saved[0]!.id).every(w => w.removed));
  assert.ok(mergeWorkspaceWidgets([], constraints, '/').every(w => w.removed));
});

test('a starter never places a widget this install does not have', () => {
  // The chat arrangement names modules that a lite install, or a machine
  // without Docker, simply never registers. What is absent from the
  // catalogue is absent from the board — and the stack it belonged to keeps
  // its other tabs rather than breaking.
  const partial = constraints.filter(c => c.id !== 'plugin:@timon/docker-supervision:docker' && !c.id.startsWith('plugin:@timon/kanban:')
    && c.id !== 'plugin:github-issues:issues');
  const chat = mergeWorkspaceWidgets(null, partial, '/chat').filter(w => !w.removed);
  assert.ok(chat.every(w => !w.id.includes('docker')));
  const right = chat.filter(w => w.rail === 'chat.right.widget');
  assert.deepEqual(right.map(w => w.id), ['plugin:@timon/git:branches', 'plugin:@timon/git:graph', 'plugin:@timon/git:publish']);
  assert.equal(right.filter(w => w.activeTab).length, 1, 'the Git stack keeps its front tab without the Kanban');
});

test('a scope that has not answered yet paints nothing, an answered empty one paints the starters', () => {
  // Before the read lands, `raw` is `null` and so is a stored "nothing": only
  // `known` tells them apart, and only the second one deserves the starters.
  assert.deepEqual(workspaceWidgets(null, false, constraints, '/'), []);
  assert.deepEqual(workspaceWidgets([{ id: constraints[0]!.id, rail: 'droite', rang: 0, hauteur: 420 }], false, constraints, '/'), []);
  const fresh = workspaceWidgets(null, true, constraints, '/').filter(w => !w.removed);
  assert.equal(fresh.length, 5, 'notifications and "Your widget here", the main agent, TODO and Tasks');
  const stored = workspaceWidgets([{ id: constraints[0]!.id, rail: 'droite', rang: 0, hauteur: 420 }], true, constraints, '/');
  assert.equal(stored.find(w => w.id === constraints[0]!.id)?.hauteur, 420);
});

test('a widget placed by default lands in its zone on every view, stored layout or not', () => {
  const bell = 'plugin:@timon/notifications:bell';
  const withBell: WidgetConstraints[] = [
    ...constraints,
    { id: bell, defaultHeight: 320, minHeight: 160, defaultZone: 'topbar.widget', defaultRank: 99, placedByDefault: true },
  ];
  // A view with a stored layout that predates the widget: it must not vanish
  // from the bar into the palette.
  const saved = [{ id: constraints[0]!.id, rail: 'droite', rang: 0, hauteur: 420 }];
  for (const [raw, view] of [[saved, '/'], [null, '/'], [null, '/kanban'], [[], '/chat']] as const) {
    const placed = mergeWorkspaceWidgets(raw, withBell, view).find(w => w.id === bell);
    assert.equal(placed?.rail, 'topbar.widget', `placed on ${view} (${raw === null ? 'nothing stored' : 'stored'})`);
    assert.ok(!placed?.removed);
  }
  // Its removal is the user's, and sticks.
  const removed = [...saved, { id: bell, rail: 'topbar.widget', rang: 0, hauteur: 320, removed: true }];
  assert.equal(mergeWorkspaceWidgets(removed, withBell, '/').find(w => w.id === bell)?.removed, true);
  // So does a move into a rail.
  const moved = [...saved, { id: bell, rail: 'sidebar.left.widget', rang: 0, hauteur: 320 }];
  assert.equal(mergeWorkspaceWidgets(moved, withBell, '/').find(w => w.id === bell)?.rail, 'sidebar.left.widget');
});

test('a renamed widget takes over the place its former id had on screen', () => {
  const bell = 'plugin:@timon/notifications:bell';
  const inbox = 'plugin:@timon/notifications:inbox';
  const withBell: WidgetConstraints[] = [
    ...constraints,
    { id: bell, defaultHeight: 320, minHeight: 160, defaultZone: 'topbar.widget', defaultRank: 99, placedByDefault: true, formerIds: [inbox] },
  ];
  const placedInbox = [{ id: inbox, rail: 'sidebar.left.widget', rang: 0, hauteur: 300, borderless: true }];
  const inherited = mergeWorkspaceWidgets(placedInbox, withBell, '/').find(w => w.id === bell);
  assert.equal(inherited?.rail, 'sidebar.left.widget');
  assert.equal(inherited?.hauteur, 300);
  assert.equal(inherited?.borderless, true);
  // A former id the user had put away hands nothing down: the widget goes to
  // its default zone, like for anyone.
  const removedInbox = [{ ...placedInbox[0]!, removed: true }];
  assert.equal(mergeWorkspaceWidgets(removedInbox, withBell, '/').find(w => w.id === bell)?.rail, 'topbar.widget');
});

test('a chat opened on another view starts from the places of /chat, then keeps its own (Q14)', () => {
  // A view whose row exists: every card it did not place is stored taken out.
  const kanban = mergeWorkspaceWidgets(null, constraints, '/kanban');
  const stored = kanban.filter(w => w.id !== 'plugin:@timon/docker-supervision:docker');
  // No chat zone mounted: nothing changes, nothing chat-like is claimed.
  const without = mergeWorkspaceWidgets(stored, constraints, '/kanban');
  assert.ok(without.filter(w => w.rail.startsWith('chat.')).every(w => w.removed), 'no chat places without a chat');

  const withChat = mergeWorkspaceWidgets(stored, constraints, '/kanban', true).filter(w => !w.removed);
  assert.deepEqual(withChat.filter(w => w.rail === 'chat.left.widget').map(w => w.id.split(':').at(-1)),
    ['Missions', 'Files'], 'stored as taken out by default: placed like on /chat');
  assert.equal(withChat.filter(w => w.rail === 'chat.right.widget').length, 7, 'absent from the row: placed too');
});

test('a card removed from a chat column of a view stays removed there (Q14)', () => {
  const kanban = mergeWorkspaceWidgets(null, constraints, '/kanban', true);
  const removed = kanban.map(w => (w.id === 'plugin:@timon/docker-supervision:docker' ? { ...w, removed: true } : w));
  assert.equal(removed.find(w => w.id === 'plugin:@timon/docker-supervision:docker')!.rail, 'chat.right.widget');
  const again = mergeWorkspaceWidgets(removed, constraints, '/kanban', true);
  assert.equal(again.find(w => w.id === 'plugin:@timon/docker-supervision:docker')!.removed, true);
  // A card the view shows elsewhere is not moved: one card, one place.
  const elsewhere = removed.map(w => (w.id === 'plugin:@timon/files-widget:Files' ? { ...w, rail: 'gauche', removed: undefined } : w));
  assert.equal(mergeWorkspaceWidgets(elsewhere, constraints, '/kanban', true).find(w => w.id === 'plugin:@timon/files-widget:Files')!.rail, 'gauche');
});

test('/chat keeps its own rule: a stored row is not re-seeded', () => {
  const stored = mergeWorkspaceWidgets(null, constraints, '/chat').map(w => (w.rail.startsWith('chat.') ? { ...w, rail: 'gauche', removed: true } : w));
  const merged = mergeWorkspaceWidgets(stored, constraints, '/chat', true);
  assert.ok(merged.filter(w => w.id === 'plugin:@timon/files-widget:Files').every(w => w.removed));
});

test('the Skills and MCP cards take over their places and their tab stack under @timon/agents (TODO #357)', () => {
  const skills = 'plugin:@timon/skills-widget:skills';
  const mcp = 'plugin:@timon/mcp-widget:mcp';
  const stack = 'stack:chat.right.skills:1';
  const stored = [
    { id: 'plugin:@timon/agents:skills', rail: 'chat.right.widget', rang: 1, hauteur: 300, group: stack },
    { id: 'plugin:@timon/agents:mcp', rail: 'chat.right.widget', rang: 2, hauteur: 300, group: stack, activeTab: true },
  ];
  const renamed: WidgetConstraints[] = [
    { id: skills, defaultHeight: 260, minHeight: 140, defaultZone: 'gauche', defaultRank: 0, formerIds: ['plugin:@timon/agents:skills'] },
    { id: mcp, defaultHeight: 220, minHeight: 120, defaultZone: 'gauche', defaultRank: 0, formerIds: ['plugin:@timon/agents:mcp'] },
  ];
  const merged = mergeWorkspaceWidgets(stored, renamed, '/chat', true);
  const s = merged.find(w => w.id === skills)!;
  const m = merged.find(w => w.id === mcp)!;
  assert.equal(s.rail, 'chat.right.widget');
  assert.equal(m.rail, 'chat.right.widget');
  assert.equal(s.group, stack);
  assert.equal(m.group, stack);
  assert.ok(m.activeTab && !s.activeTab, 'MCP stays the tab shown');
  assert.ok(!s.removed && !m.removed);
});

test('TODO #278: the Git widgets take over the place of the former publication card, else of the Git panel', () => {
  const former = ['plugin:@timon/git:repository', 'plugin:@timon/git:git-remote', 'plugin:@timon/git:Git'];
  const parts = ['plugin:@timon/git:branches', 'plugin:@timon/git:graph', 'plugin:@timon/git:publish'];
  const withFormer = constraints.map(c => parts.includes(c.id) ? { ...c, formerIds: former } : c);
  const both = [
    { id: 'plugin:@timon/git:Git', rail: 'chat.left.widget', rang: 3, hauteur: 300 },
    { id: 'plugin:@timon/git:git-remote', rail: 'chat.right.widget', rang: 1, hauteur: 250 },
  ];
  const a = mergeWorkspaceWidgets(both, withFormer, '/chat').filter(w => parts.includes(w.id));
  assert.ok(a.every(w => w.rail === 'chat.right.widget' && !w.removed));
  // The publication card had been taken off: the Git panel's place is used.
  const panelOnly = [both[0]!, { ...both[1]!, removed: true }];
  const b = mergeWorkspaceWidgets(panelOnly, withFormer, '/chat').filter(w => parts.includes(w.id));
  assert.ok(b.every(w => w.rail === 'chat.left.widget' && !w.removed));
});

test('the Git card of a stored chat becomes the Git stack, at its place and height, with the pull requests and jobs', () => {
  const former = ['plugin:@timon/git:repository', 'plugin:@timon/git:git-remote', 'plugin:@timon/git:Git'];
  const parts = ['plugin:@timon/git:branches', 'plugin:@timon/git:graph', 'plugin:@timon/git:publish'];
  const kanban = ['plugin:@timon/kanban:pull-requests', 'plugin:@timon/kanban:landings', 'plugin:github-issues:issues'];
  const docker = 'plugin:@timon/docker-supervision:docker';
  const withFormer = constraints.map(c => parts.includes(c.id) ? { ...c, formerIds: former } : c);
  // A chat row stored before the split: the Git card under Docker, the
  // pull request widgets never named (they shipped with the stack).
  const stored = [
    { id: 'plugin:@timon/missions:Missions', rail: 'chat.left.widget', rang: 0, hauteur: 300 },
    { id: docker, rail: 'chat.right.widget', rang: 0, hauteur: 200 },
    { id: 'plugin:@timon/git:repository', rail: 'chat.right.widget', rang: 1, hauteur: 410, heightMode: 'fill', fillPercent: 70 },
  ];
  const merged = mergeWorkspaceWidgets(stored, withFormer, '/chat');
  const right = merged.filter(w => !w.removed && w.rail === 'chat.right.widget').sort((x, y) => x.rang - y.rang);
  assert.deepEqual(right.map(w => w.id), [docker, ...parts, ...kanban], 'below Docker, where the card stood');
  const stack = right.filter(w => w.id !== docker);
  assert.equal(new Set(stack.map(w => w.group)).size, 1);
  assert.ok(stack[0]!.group);
  assert.deepEqual(stack.map(w => w.activeTab === true), [true, false, false, false, false, false], 'Branches in front');
  assert.ok(stack.every(w => w.hauteur === 410 && w.heightMode === 'fill' && w.fillPercent === 70), 'at the card\'s height');
  assert.equal(right[0]!.group, undefined, 'Docker stays a card of its own');

  // Pull requests already placed or put away by the person: left as they are.
  const placed = [...stored, { id: kanban[0]!, rail: 'gauche', rang: 0, hauteur: 300 }, { id: kanban[1]!, rail: 'droite', rang: 0, hauteur: 300, removed: true }];
  const kept = mergeWorkspaceWidgets(placed, withFormer, '/chat');
  assert.equal(kept.find(w => w.id === kanban[0])?.rail, 'gauche');
  assert.equal(kept.find(w => w.id === kanban[1])?.removed, true);

  // The Git card had been taken out: nothing comes back, and the pull
  // requests have no stack to join.
  const away = mergeWorkspaceWidgets([stored[0]!, stored[1]!, { ...stored[2]!, removed: true }], withFormer, '/chat');
  assert.ok([...parts, ...kanban].every(id => away.find(w => w.id === id)?.removed === true));
});

test('a widget added to the Git stack later joins it where the person moved it', () => {
  const docker = 'plugin:@timon/docker-supervision:docker';
  const stack = 'stack:mine:4';
  // The Git widgets moved into the left column, stacked there with Docker;
  // the jobs widget unknown to the row.
  const stored = mergeWorkspaceWidgets(null, constraints, '/chat')
    .filter(w => w.id !== 'plugin:@timon/kanban:landings')
    .map(w => (w.id.startsWith('plugin:@timon/git:') || w.id === 'plugin:@timon/kanban:pull-requests' || w.id === 'plugin:github-issues:issues' || w.id === docker
      ? { ...w, rail: 'chat.left.widget', group: stack, activeTab: w.id === docker ? true : undefined, rang: 10 + w.rang }
      : w));
  const merged = mergeWorkspaceWidgets(stored, constraints, '/chat');
  const jobs = merged.find(w => w.id === 'plugin:@timon/kanban:landings')!;
  assert.equal(jobs.rail, 'chat.left.widget');
  assert.equal(jobs.group, stack);
  assert.ok(!jobs.activeTab && !jobs.removed);
  const tabs = merged.filter(w => !w.removed && w.group === stack).sort((a, b) => a.rang - b.rang).map(w => w.id);
  assert.equal(tabs.at(-1), 'plugin:@timon/kanban:landings', 'at the end of the stack');

  // A sibling taken out of every stack makes no new stack around it.
  const loose = stored.map(w => (w.group === stack ? { ...w, group: undefined, activeTab: undefined } : w));
  assert.equal(mergeWorkspaceWidgets(loose, constraints, '/chat').find(w => w.id === 'plugin:@timon/kanban:landings')?.removed, true);
});

test('Issues joins a Git stack stored before it, as its last tab, behind the one in front', () => {
  const issues = 'plugin:github-issues:issues';
  // A view saved with the five-tab stack, the person having brought Pull requests to the front.
  const stored = mergeWorkspaceWidgets(null, constraints, '/chat')
    .filter(w => w.id !== issues)
    .map(w => (w.group ? { ...w, activeTab: w.id === 'plugin:@timon/kanban:pull-requests' ? true : undefined } : w));
  const merged = mergeWorkspaceWidgets(stored, constraints, '/chat');
  const tabs = merged.filter(w => !w.removed && w.group === 'stack:git').sort((a, b) => a.rang - b.rang);
  assert.deepEqual(tabs.map(w => w.id.split(':').at(-1)), ['branches', 'graph', 'publish', 'pull-requests', 'landings', 'issues']);
  assert.deepEqual(tabs.filter(w => w.activeTab).map(w => w.id), ['plugin:@timon/kanban:pull-requests'], 'the tab in front stays in front');
  // Without the plugin, the widget never registers: the stack keeps its five tabs.
  const without = mergeWorkspaceWidgets(stored, constraints.filter(c => c.id !== issues), '/chat');
  assert.equal(without.filter(w => !w.removed && w.group === 'stack:git').length, 5);
});

// TODO #479: the agent strip became the Working agents widget. It was on
// screen on every view, so a view stored before it gets it in the middle of
// the top bar, whatever it did with the former "Agents list" card. The
// marker is the id's absence from the row: it did not exist before #479, and a
// row that names it was written since — a removal there is the user's.
test('Working agents lands in the middle of the top bar on every view that never named it', () => {
  const working = 'plugin:@timon/agents:working';
  const team = 'plugin:@timon/agents:team';
  const withWorking: WidgetConstraints[] = [
    ...constraints.filter(c => c.id !== team),
    { id: working, defaultHeight: 300, minHeight: 120, defaultZone: 'topbar.center.widget', defaultRank: 99, placedByDefault: true },
  ];
  const placeOf = (raw: unknown, view = '/') => mergeWorkspaceWidgets(raw, withWorking, view).find(w => w.id === working);
  for (const view of ['/', '/chat', '/agents']) {
    assert.equal(placeOf(null, view)?.rail, 'topbar.center.widget', `fresh install, ${view}`);
    assert.ok(!placeOf(null, view)?.removed);
  }
  // Views customised before #479: the list card removed, placed in the
  // cockpit, or placed in a chat column tab (the regression, 28/10/2026).
  for (const stored of [
    [{ id: MAIN_AGENT_WIDGET_ID, rail: 'centre', rang: 0, hauteur: 520 }, { id: team, rail: 'gauche', rang: 3, hauteur: 300, removed: true }],
    [{ id: MAIN_AGENT_WIDGET_ID, rail: 'centre', rang: 0, hauteur: 520 }, { id: team, rail: 'gauche', rang: 1, hauteur: 280 }],
    [{ id: team, rail: 'chat.right.widget#muvis5up', rang: 1, hauteur: 300 }],
  ]) {
    for (const view of ['/', '/chat']) {
      assert.equal(placeOf(stored, view)?.rail, 'topbar.center.widget', `${view} ${JSON.stringify(stored)}`);
      assert.ok(!placeOf(stored, view)?.removed);
    }
  }
  // Removed from the top bar after #479: it stays away, on that view only.
  const away = [{ id: working, rail: 'topbar.center.widget', rang: 0, hauteur: 300, removed: true }];
  assert.equal(placeOf(away)?.removed, true);
  assert.equal(placeOf([], '/chat')?.removed, undefined);
  // Moved by hand: it stays where it was put.
  assert.equal(placeOf([{ id: working, rail: 'sidebar.left.widget', rang: 0, hauteur: 300 }])?.rail, 'sidebar.left.widget');
});

test('a card split into several widgets hands its place to all of them, as one stack', () => {
  const card = 'plugin:@acme/tools:card';
  const parts = ['plugin:@acme/tools:a', 'plugin:@acme/tools:b', 'plugin:@acme/tools:c'];
  const split: WidgetConstraints[] = [
    ...constraints,
    ...parts.map((id, i) => ({ id, defaultHeight: 200, minHeight: 100, defaultZone: 'droite', defaultRank: 10 + i, formerIds: [card] })),
  ];
  const docker = 'plugin:@timon/docker-supervision:docker';
  const stored = [
    { id: card, rail: 'chat.right.widget', rang: 0, hauteur: 340, heightMode: 'fill', fillPercent: 60 },
    { id: docker, rail: 'chat.right.widget', rang: 1, hauteur: 260 },
  ];
  const merged = mergeWorkspaceWidgets(stored, split, '/chat');
  const heirs = parts.map((id) => merged.find((w) => w.id === id)!);
  assert.ok(heirs.every((w) => !w.removed && w.rail === 'chat.right.widget'), 'all three where the card stood');
  assert.equal(new Set(heirs.map((w) => w.group)).size, 1, 'one stack');
  assert.ok(heirs[0]!.group, 'a real stack, not three loose cards');
  assert.deepEqual(heirs.map((w) => w.activeTab === true), [true, false, false], 'the first part in front');
  assert.ok(heirs.every((w) => w.hauteur === 340 && w.heightMode === 'fill' && w.fillPercent === 60), 'at the card\'s height');
  const column = merged.filter((w) => !w.removed && w.rail === 'chat.right.widget').sort((a, b) => a.rang - b.rang).map((w) => w.id);
  assert.deepEqual(column, [...parts, docker], 'above the card that followed it');

  // The card was a background tab of the person's own stack: the parts stay
  // there, behind the tab that was in front.
  const stack = 'stack:mine:1';
  const tabbed = [
    { ...stored[0]!, group: stack },
    { ...stored[1]!, group: stack, activeTab: true },
  ];
  const kept = mergeWorkspaceWidgets(tabbed, split, '/chat');
  assert.ok(parts.every((id) => kept.find((w) => w.id === id)?.group === stack));
  assert.ok(parts.every((id) => !kept.find((w) => w.id === id)?.activeTab), 'Docker stays in front');
  assert.equal(kept.find((w) => w.id === docker)?.activeTab, true);

  // The card had been taken out: so are its parts, nothing comes back.
  const away = mergeWorkspaceWidgets([{ ...stored[0]!, removed: true }, stored[1]!], split, '/chat');
  assert.ok(parts.every((id) => away.find((w) => w.id === id)?.removed === true));
});
