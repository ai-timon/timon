import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_TURN_BYTES,
  admitWithinTurnBudget,
  extensionOf,
  fileIconFor,
  fmtAttachmentSize,
  turnAttachmentBytes,
  type PendingFile,
} from './attachments';

test('the icon follows the extension, which is the only thing that never lies', () => {
  // A .pptx dragged from a file explorer routinely arrives as
  // application/octet-stream: choosing on MIME would show a blank page icon.
  assert.equal(fileIconFor('deck.pptx').icon.displayName, 'Presentation');
  assert.equal(fileIconFor('RAPPORT.PDF').icon.displayName, 'FileType');
  assert.equal(fileIconFor('data.csv').icon.displayName, 'FileSpreadsheet');
  assert.equal(fileIconFor('notes.md').icon.displayName, 'FileText');
  assert.equal(fileIconFor('archive.7z').icon.displayName, 'FileArchive');
});

test('an unknown or extensionless name is attachable, never refused', () => {
  for (const name of ['Dockerfile', 'Makefile', '.gitignore', 'thing.qqq', '']) {
    assert.equal(fileIconFor(name).icon.displayName, 'File');
  }
  assert.equal(extensionOf('.gitignore'), '');
  assert.equal(extensionOf('a/b/c.tar.gz'), 'gz');
});

test('sizes read at a glance', () => {
  assert.equal(fmtAttachmentSize(512), '512 B');
  assert.equal(fmtAttachmentSize(2048), '2 KB');
  assert.equal(fmtAttachmentSize(3 * 1024 * 1024), '3.0 MB');
});

test('the turn budget fits the daemon body cap once base64-encoded, text included (TIM-0125)', () => {
  assert.ok(Math.ceil(MAX_TURN_BYTES / 3) * 4 + 1024 * 1024 <= 25 * 1024 * 1024);
});

test('images, files and pasted text all count toward one message', () => {
  const files: PendingFile[] = [
    { id: 'a', kind: 'file', name: 'a.pdf', mediaType: 'application/pdf', base64: '', size: 1000 },
    { id: 'b', kind: 'pasted', name: 'Pasted', mediaType: 'text/plain', text: 'é'.repeat(10), size: 10 }, // french-ok: multi-byte text, the size under test
  ];
  // The paste counts in UTF-8 bytes, not characters.
  assert.equal(turnAttachmentBytes([{ size: 500 }], files), 1520);
});

test('ten phone photos are refused past the budget, a smaller one after them still fits', () => {
  const mb = 1024 * 1024;
  const photos = Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, size: 2.5 * mb }));
  const plan = admitWithinTurnBudget(0, [...photos, { id: 'small', size: 0.4 * mb }]);
  assert.equal(plan.admitted.length, 8);
  assert.deepEqual(plan.refused.map((p) => p.id), ['p7', 'p8', 'p9']);
  assert.ok(plan.admitted.some((p) => p.id === 'small'));
  assert.ok(plan.used <= MAX_TURN_BYTES);
  // What is already pending counts.
  assert.equal(admitWithinTurnBudget(MAX_TURN_BYTES, [{ size: 1 }]).refused.length, 1);
});
