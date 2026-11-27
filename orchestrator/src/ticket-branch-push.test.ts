import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkTicketBranchPush, ticketPrefixesFromText, ticketPushArguments, type TicketPushContext } from './ticket-branch-push.js';

const TASK = '0f9c1e52-7b1a-4c3e-9d2f-1a2b3c4d5e6f';
const OTHER = 'aaaaaaaa-0000-4000-8000-000000000001';
const ctx = (over: Partial<TicketPushContext> = {}): TicketPushContext => ({
  remote: 'origin',
  ticketPrefixes: ['SELP', 'IT'],
  protectedBranches: ['staging'],
  isProjectTaskBranch: (id) => id === TASK || id === OTHER,
  isProjectDir: (dir) => dir === '/repo' || dir.startsWith('/repo/'),
  ...over,
});
const src = `timon/task/${TASK}`;

const ACCEPTED: Array<[string, string]> = [
  ['the incident command', `git push origin ${src}:refs/heads/SELP-13105_remove-composer-dev`],
  ['no refs/heads', `git push origin ${src}:SELP-13105_remove-composer-dev`],
  ['implicit remote', `git push ${src}:refs/heads/IT-7_fix.thing`],
  ['upstream short', `git push -u origin ${src}:refs/heads/SELP-1_a`],
  ['upstream long', `git push --set-upstream origin ${src}:SELP-1_a`],
  ['-C in the project', `git -C /repo/wt push origin ${src}:SELP-1_a`],
  ['another task of the project', `git push origin timon/task/${OTHER}:SELP-1_a`],
];

const REFUSED: Array<[string, string]> = [
  ['another remote', `git push upstream ${src}:SELP-1_a`],
  ['a URL', `git push https://gitlab.selp.fr/x/y.git ${src}:SELP-1_a`],
  ['develop', `git push origin ${src}:develop`],
  ['main', `git push origin ${src}:refs/heads/main`],
  ['master', `git push origin ${src}:master`],
  ['production', `git push origin ${src}:production`],
  ['release', `git push origin ${src}:release`],
  ['release/*', `git push origin ${src}:release/1.0`],
  ['a known protected branch', `git push origin ${src}:staging`],
  ['a tag ref', `git push origin ${src}:refs/tags/SELP-1_a`],
  ['a ref outside heads', `git push origin ${src}:refs/for/SELP-1_a`],
  ['a glob', `git push origin ${src}:SELP-1_*`],
  ['an unknown prefix', `git push origin ${src}:ABC-1_a`],
  ['no description', `git push origin ${src}:SELP-1`],
  ['uppercase description', `git push origin ${src}:SELP-1_Abc`],
  ['a slash in the name', `git push origin ${src}:SELP-1_a/b`],
  ['a non-task source', 'git push origin HEAD:SELP-1_a'],
  ['a developer branch as source', 'git push origin feature/x:SELP-1_a'],
  ['a task of another project', `git push origin timon/task/bbbbbbbb-0000-4000-8000-000000000002:SELP-1_a`],
  ['a source with no destination', `git push origin ${src}`],
  ['a source with an empty destination', `git push origin ${src}:`],
  ['a deletion refspec', 'git push origin :SELP-1_a'],
  ['--force', `git push --force origin ${src}:SELP-1_a`],
  ['-f', `git push -f origin ${src}:SELP-1_a`],
  ['--force-with-lease', `git push --force-with-lease origin ${src}:SELP-1_a`],
  ['a +refspec', `git push origin +${src}:SELP-1_a`],
  ['--mirror', 'git push --mirror origin'],
  ['--delete', `git push --delete origin SELP-1_a`],
  ['--all', 'git push --all origin'],
  ['--tags', `git push --tags origin ${src}:SELP-1_a`],
  ['-o', `git push -o ci.skip origin ${src}:SELP-1_a`],
  ['--push-option', `git push --push-option=x origin ${src}:SELP-1_a`],
  ['--receive-pack', `git push --receive-pack=evil origin ${src}:SELP-1_a`],
  ['two refspecs', `git push origin ${src}:SELP-1_a ${src}:SELP-2_b`],
  ['&&', `git push origin ${src}:SELP-1_a && rm -rf /`],
  ['a semicolon', `git push origin ${src}:SELP-1_a; ls`],
  ['a pipe', `git push origin ${src}:SELP-1_a | cat`],
  ['a substitution', `git push origin ${src}:SELP-1_$(id)`],
  ['backticks', `git push origin ${src}:SELP-1_\`id\``],
  ['a newline', `git push origin ${src}:SELP-1_a\nls`],
  ['quotes', `git push origin '${src}:SELP-1_a'`],
  ['-C outside the project', `git -C /etc push origin ${src}:SELP-1_a`],
  ['-C relative', `git -C wt push origin ${src}:SELP-1_a`],
  ['-c config', `git -c core.sshCommand=evil push origin ${src}:SELP-1_a`],
  ['not git', `echo push origin ${src}:SELP-1_a`],
  ['not a push', `git fetch origin ${src}:SELP-1_a`],
  ['a dotted lock name', `git push origin ${src}:SELP-1_a.lock`],
  ['a double dot', `git push origin ${src}:SELP-1_a..b`],
];

for (const [label, command] of ACCEPTED) {
  test(`accepted: ${label}`, () => {
    const out = checkTicketBranchPush(command, ctx());
    assert.equal(out.ok, true, JSON.stringify(out));
  });
}
for (const [label, command] of REFUSED) {
  test(`refused: ${label}`, () => {
    const out = checkTicketBranchPush(command, ctx());
    assert.equal(out.ok, false, command);
  });
}

test('the parsed push of the incident command', () => {
  const out = checkTicketBranchPush(`git push origin ${src}:refs/heads/SELP-13105_remove-composer-dev`, ctx());
  assert.ok(out.ok);
  assert.deepEqual(out.push, {
    remote: 'origin', src, taskId: TASK, dst: 'SELP-13105_remove-composer-dev', setUpstream: false, dir: null,
  });
  assert.deepEqual(ticketPushArguments(out.push, '/repo'), ['-C', '/repo', 'push', 'origin', `${src}:refs/heads/SELP-13105_remove-composer-dev`]);
});

test('without known prefixes the generic pattern applies', () => {
  assert.ok(checkTicketBranchPush(`git push origin ${src}:ABC-1_a`, ctx({ ticketPrefixes: [] })).ok);
  assert.ok(!checkTicketBranchPush(`git push origin ${src}:abc-1_a`, ctx({ ticketPrefixes: [] })).ok);
  assert.ok(!checkTicketBranchPush(`git push origin ${src}:A-1_a`, ctx({ ticketPrefixes: [] })).ok);
});

test('another configured remote is accepted only by name', () => {
  assert.ok(checkTicketBranchPush(`git push gitlab ${src}:SELP-1_a`, ctx({ remote: 'gitlab' })).ok);
  assert.ok(!checkTicketBranchPush(`git push origin ${src}:SELP-1_a`, ctx({ remote: 'gitlab' })).ok);
});

test('ticket prefixes are read from a pole speech or a ticket_prefixes line', () => {
  assert.deepEqual(ticketPrefixesFromText('B2B: x. Tracker: ClickUp, ticket prefixes `SELP-`, `IT-`. GitLab: y'), ['SELP', 'IT']);
  assert.deepEqual(ticketPrefixesFromText('ticket_prefixes: [SELP, IT]'), ['SELP', 'IT']);
  assert.deepEqual(ticketPrefixesFromText('No ticket rule.'), []);
  assert.deepEqual(ticketPrefixesFromText(null), []);
});
