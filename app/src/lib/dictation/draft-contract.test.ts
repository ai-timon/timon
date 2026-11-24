// french-ok-file: French dictation samples
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { beginDictationDraft, cancelDictationDraft, writeDictationDraft } from './draft-contract';

test('the transcript edits the draft it started from, write after write', () => {
  let draft = beginDictationDraft('chat:a', 'Bonjour');
  draft = writeDictationDraft(draft, { owner: 'chat:a', text: 'Bonjour' }, 'Bonjour il faut')!;
  draft = writeDictationDraft(draft, { owner: 'chat:a', text: 'Bonjour il faut' }, 'Bonjour il faut tester.')!;
  assert.equal(draft.written, 'Bonjour il faut tester.');
  assert.equal(draft.original, 'Bonjour');
});

test('a late transcript does not overwrite a draft the user edited meanwhile', () => {
  const draft = writeDictationDraft(beginDictationDraft('chat:a', ''), { owner: 'chat:a', text: '' }, 'il faut')!;
  assert.equal(writeDictationDraft(draft, { owner: 'chat:a', text: 'il faut, je corrige' }, 'il faut tester.'), null);
});

test('a transcript never lands in another conversation\'s draft', () => {
  const draft = beginDictationDraft('chat:a', 'brouillon A');
  assert.equal(writeDictationDraft(draft, { owner: 'chat:b', text: 'brouillon A' }, 'brouillon A suite'), null);
});

test('Escape puts back the draft as it was before the recording', () => {
  const draft = writeDictationDraft(beginDictationDraft('chat:a', 'Avant'), { owner: 'chat:a', text: 'Avant' }, 'Avant et après')!;
  assert.equal(cancelDictationDraft(draft, { owner: 'chat:a', text: 'Avant et après' }), 'Avant');
});

test('Escape in another conversation restores nothing', () => {
  const draft = beginDictationDraft('chat:a', 'Avant');
  assert.equal(cancelDictationDraft(draft, { owner: 'chat:b', text: 'autre' }), null);
});

test('a user edit before the first transcript also wins: the dictation never writes', () => {
  const draft = beginDictationDraft('chat:a', 'Bonjour');
  assert.equal(writeDictationDraft(draft, { owner: 'chat:a', text: 'Bonjour, je tape' }, 'Bonjour il faut'), null);
});

test('only an exact match of the last write keeps the right to write', () => {
  const draft = writeDictationDraft(beginDictationDraft('chat:a', ''), { owner: 'chat:a', text: '' }, 'il faut')!;
  // A trailing space or an erased letter is still the user's edit.
  assert.equal(writeDictationDraft(draft, { owner: 'chat:a', text: 'il faut ' }, 'il faut tester.'), null);
  assert.equal(writeDictationDraft(draft, { owner: 'chat:a', text: 'il fau' }, 'il faut tester.'), null);
});
