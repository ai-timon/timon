// french-ok-file: the localised part labels under test
/**
 * The mascot pack contract: what a part must be to be drawn, and the strict
 * reader of an accessory's markup. The refusals come first: a pack's drawing
 * is painted inside every agent's head that wears it, so it must never run a
 * script, react to an event or reach anything outside the page.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mascotPartLabel, mascotPartProblem, readMascotSvg } from './parts-contract';

const refused = (markup: string): string => {
  const read = readMascotSvg(markup);
  assert.equal(read.ok, false, `must be refused: ${markup}`);
  return read.ok ? '' : read.reason;
};

test('a script, an event handler, a link or a style is refused, never skipped', () => {
  assert.match(refused('<script>alert(1)</script>'), /<script> is not allowed/);
  assert.match(refused('<g><script>alert(1)</script></g>'), /<script> is not allowed/);
  assert.match(refused('<rect width="4" height="4" onclick="alert(1)"/>'), /attribute onclick is not allowed/);
  assert.match(refused('<rect width="4" height="4" onload="alert(1)"/>'), /attribute onload is not allowed/);
  assert.match(refused('<a href="https://evil.example"><rect width="4" height="4"/></a>'), /<a> is not allowed/);
  assert.match(refused('<image href="https://evil.example/x.png" width="4" height="4"/>'), /<image> is not allowed/);
  assert.match(refused('<use href="#x"/>'), /<use> is not allowed/);
  assert.match(refused('<foreignObject><div/></foreignObject>'), /<foreignObject> is not allowed/);
  assert.match(refused('<style>rect{fill:url(https://evil.example)}</style>'), /<style> is not allowed/);
  assert.match(refused('<rect width="4" height="4" style="fill:red"/>'), /attribute style is not allowed/);
  assert.match(refused('<rect width="4" height="4" xlink:href="javascript:alert(1)"/>'), /attribute xlink:href is not allowed/);
  assert.match(refused('<animate attributeName="x"/>'), /<animate> is not allowed/);
  assert.match(refused('<svg><rect width="4" height="4"/></svg>'), /<svg> is not allowed/);
});

test('an external or internal reference inside a value is refused', () => {
  assert.match(refused('<rect width="4" height="4" fill="url(https://evil.example/p.svg#a)"/>'), /character|url/);
  assert.match(refused('<rect width="4" height="4" fill="url(#g)"/>'), /calls url\(\)/);
  assert.match(refused('<rect width="4" height="4" fill="javascript:alert(1)"/>'), /character a drawing does not need/);
  assert.match(refused('<rect width="4" height="4" fill="&#106;avascript"/>'), /character a drawing does not need/);
  assert.match(refused('<rect width="4" height="4" transform="expression(alert(1))"/>'), /calls expression\(\)/);
});

test('text, declarations, unclosed or malformed markup is refused', () => {
  assert.match(refused('hello'), /text is not allowed/);
  assert.match(refused('<g>hello</g>'), /text is not allowed/);
  assert.match(refused('<!DOCTYPE svg><rect/>'), /declarations/);
  assert.match(refused('<![CDATA[x]]>'), /declarations/);
  assert.match(refused('<?xml version="1.0"?><rect/>'), /declarations/);
  assert.match(refused('<g><rect width="4" height="4"/>'), /<g> is not closed/);
  assert.match(refused('<g></rect>'), /closes <g>/);
  assert.match(refused('<rect width=4/>'), /must be quoted/);
  assert.match(refused('<rect width="4" width="5"/>'), /repeated/);
  assert.match(refused('<!-- only a comment -->'), /draws nothing/);
  assert.match(refused(''), /draws nothing/);
  assert.match(refused(`<g>${'<g>'.repeat(20)}${'</g>'.repeat(20)}</g>`), /nested deeper/);
  assert.match(refused('<rect width="1" height="1"/>'.repeat(201)), /more than 200 elements/);
  assert.match(refused(`<path d="${'M0 0'.repeat(5000)}"/>`), /longer than/);
});

test('shapes and presentation attributes are kept, as React props', () => {
  const read = readMascotSvg(`
    <!-- a cap -->
    <g transform="rotate(-10) translate(0 1)" opacity=".9">
      <path d="M-9 2 C -9 -8, 9 -8, 9 2 Z" fill="#3fa9ff" stroke="rgb(20, 40, 60)" stroke-width="1.2" stroke-linecap="round"/>
      <rect x="-12" y="1" width="24" height="3.5" rx="1.75" fill="#2b7fd0"/>
    </g>`);
  assert.ok(read.ok, read.ok ? '' : read.reason);
  assert.deepEqual(read.nodes, [{
    tag: 'g',
    props: { transform: 'rotate(-10) translate(0 1)', opacity: '.9' },
    children: [
      { tag: 'path', props: { d: 'M-9 2 C -9 -8, 9 -8, 9 2 Z', fill: '#3fa9ff', stroke: 'rgb(20, 40, 60)', strokeWidth: '1.2', strokeLinecap: 'round' }, children: [] },
      { tag: 'rect', props: { x: '-12', y: '1', width: '24', height: '3.5', rx: '1.75', fill: '#2b7fd0' }, children: [] },
    ],
  }]);
});

test('a part is checked whole: label, type and the data of its type', () => {
  const cap = { type: 'acc', label: 'Cap', svg: '<rect width="4" height="4"/>' };
  assert.equal(mascotPartProblem(cap), null);
  assert.match(mascotPartProblem({ ...cap, svg: '<script/>' })!, /svg refused: <script> is not allowed/);
  assert.match(mascotPartProblem({ ...cap, tilt: 120 })!, /tilt/);
  assert.match(mascotPartProblem({ ...cap, label: '' })!, /label/);
  assert.match(mascotPartProblem({ ...cap, label: { en: 'x'.repeat(41) } })!, /label/);
  assert.match(mascotPartProblem({ ...cap, type: 'hat' })!, /type must be one of shape, color, eyes, acc/);
  assert.equal(mascotPartProblem({ type: 'color', label: 'Night', hex: '#1D2B53' }), null);
  assert.match(mascotPartProblem({ type: 'color', label: 'Night', hex: 'navy' })!, /#rrggbb/);
  assert.equal(mascotPartProblem({ type: 'shape', label: 'Blob', skull: { top: 70, bottom: 90, height: 70, radius: 34 } }), null);
  // A skull is four bounded numbers: a free outline would not carry the ears, mask and screen.
  assert.match(mascotPartProblem({ type: 'shape', label: 'Blob', skull: { top: 30, bottom: 90, height: 70, radius: 34 } })!, /skull\.top must be a number from 56 to 96/);
  assert.match(mascotPartProblem({ type: 'shape', label: 'Blob', skull: { top: 70, bottom: 90, height: 70 } })!, /skull\.radius/);
  const eye = [[0, -5], [4, 0], [0, 5], [-4, 0]];
  assert.equal(mascotPartProblem({ type: 'eyes', label: 'Gem', left: eye }), null);
  assert.equal(mascotPartProblem({ type: 'eyes', label: 'Gem', left: eye, right: eye, middle: eye, blink: false }), null);
  assert.match(mascotPartProblem({ type: 'eyes', label: 'Gem', left: [[0, 0], [1, 1]] })!, /3 to 128 points/);
  assert.match(mascotPartProblem({ type: 'eyes', label: 'Gem', left: [[0, -20], [4, 0], [0, 5]] })!, /leaves the eye/);
  assert.match(mascotPartProblem({ type: 'eyes', label: 'Gem', left: [[0, Number.NaN], [4, 0], [0, 5]] })!, /\[x, y\] points/);
  assert.match(mascotPartProblem(null)!, /object/);
});

test('a shape is either a skull or a head the pack draws, never both, never neither', () => {
  const Head = (): null => null;
  const skull = { top: 70, bottom: 90, height: 70, radius: 34 };
  assert.equal(mascotPartProblem({ type: 'shape', label: 'Flame', head: Head }), null);
  assert.match(mascotPartProblem({ type: 'shape', label: 'Flame', head: '<svg/>' })!, /head must be a component \(a function\)/);
  assert.match(mascotPartProblem({ type: 'shape', label: 'Flame', head: null })!, /head must be a component/);
  assert.match(mascotPartProblem({ type: 'shape', label: 'Flame', head: Head, skull })!, /either skull or head, not both/);
  assert.match(mascotPartProblem({ type: 'shape', label: 'Flame' })!, /a shape needs skull \{ top, bottom, height, radius \}/);
  // The label is checked first, head or not.
  assert.match(mascotPartProblem({ type: 'shape', label: '', head: Head })!, /label/);
  // A head is read for a shape only: on another type it changes nothing.
  assert.match(mascotPartProblem({ type: 'color', label: 'Night', hex: 'navy', head: Head })!, /#rrggbb/);
});

test('a label is read in the reader\'s language, then its base language, then English', () => {
  const label = { en: 'Cap', fr: 'Casquette', 'pt-BR': 'Boné' };
  assert.equal(mascotPartLabel(label, 'fr', 'cap'), 'Casquette');
  assert.equal(mascotPartLabel(label, 'fr-CA', 'cap'), 'Casquette');
  assert.equal(mascotPartLabel(label, 'pt-BR', 'cap'), 'Boné');
  assert.equal(mascotPartLabel(label, 'de', 'cap'), 'Cap');
  assert.equal(mascotPartLabel({ de: 'Mütze' }, 'ja', 'cap'), 'Mütze');
  assert.equal(mascotPartLabel('Cap', 'fr', 'cap'), 'Cap');
});
