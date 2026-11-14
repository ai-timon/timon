/**
 * A custom role's icon is markup the daemon stores; the client re-checks it
 * against the same closed grammar and draws it from the parsed shapes, so a
 * roles.json armed by hand never reaches the DOM as HTML.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { JSDOM } from 'jsdom';
import {
  appendRoleSvg,
  hydrateCustomRoles,
  loadLucideIconSet,
  lucideIconByName,
  resolveRole,
  roleIconSvg,
  roleSvgFromRenderedIcon,
  sanitizeRoleSvg,
} from './roles';
import { RoleSvg } from '../components/role-svg';

// The tests compile JSX with the classic runtime (tsconfig keeps `preserve`).
Object.defineProperty(globalThis, 'React', { value: React, configurable: true, writable: true });

const LUCIDE_DOM =
  '<path d="M12 7v14"></path><circle cx="12" cy="12" r="3"></circle><g transform="translate(1 1)"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"></rect></g>';
const CANONICAL =
  '<path d="M12 7v14"/><circle cx="12" cy="12" r="3"/><g transform="translate(1 1)"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/></g>';

const TRAPPED = [
  '<image href="x" onerror="alert(1)"/>',
  '<script>alert(1)</script>',
  '<path d="M1 1" onload="alert(1)"/>',
  '<path d="M1 1" style="fill:red"/>',
  '<path fill="currentColor"/>',
  '<path d="M1 1" fill="url(#x)"/>',
  '<circle r="3" stroke="url(evil)"/>',
  '<path xlink:href="#a"/>',
  '<foreignObject><div>x</div></foreignObject>',
  '<use href="#a"/>',
  '<path d="&#97;"/>',
  '<![CDATA[x]]><path/>',
  '<path d="M1 1"/>text',
  '<path d="url(javascript:alert(1))"/>',
  '<path d="M1 1"><path/></path>',
  '<path d="M1 1">',
  '<svg><path/></svg>',
  `<path d="${'1 '.repeat(2100)}"/>`,
];

test('built-in and picker-captured lucide icons survive sanitizeRoleSvg', () => {
  for (const key of ['coder', 'reviewer', 'merger', 'librarian', 'ops', 'research', 'orchestrator']) {
    const svg = roleIconSvg(key);
    assert.ok(svg, key);
    assert.equal(sanitizeRoleSvg(svg), svg, `${key} is already canonical`);
  }
  assert.equal(sanitizeRoleSvg(LUCIDE_DOM), CANONICAL);
});

test('the picker keeps only geometry from the icon it rendered', () => {
  const rendered = LUCIDE_DOM.replace('r="3"', 'r="3" fill="currentColor" class="x"');
  assert.equal(sanitizeRoleSvg(rendered), '', 'stored markup with paint attributes is refused');
  assert.equal(roleSvgFromRenderedIcon(rendered), CANONICAL);
  for (const svg of ['<image href="x"/>', '<script>alert(1)</script>', '<path d="url(javascript:alert(1))"/>', '<path d="&#97;"/>']) {
    assert.equal(roleSvgFromRenderedIcon(svg), '', svg);
  }
});

test('sanitizeRoleSvg empties any icon outside the shape grammar', () => {
  for (const svg of TRAPPED) assert.equal(sanitizeRoleSvg(svg), '', JSON.stringify(svg.slice(0, 40)));
  assert.equal(sanitizeRoleSvg(undefined), '');
  assert.equal(sanitizeRoleSvg(42), '');
});

test('hydrated custom roles carry a sanitized icon only', () => {
  hydrateCustomRoles([
    { id: 'Svg-Armed', label: 'Armed', color: '#123456', iconSvg: '<image href="x" onerror="alert(1)"/>' },
    { id: 'svg-clean', label: 'Clean', color: '#123456', iconSvg: LUCIDE_DOM },
  ]);
  assert.equal(resolveRole('svg-armed')?.iconSvg, '');
  assert.equal(resolveRole('svg-clean')?.iconSvg, CANONICAL);
});

test('a known lucide icon name draws its component, anything else falls back to shapes', async () => {
  const icons = await loadLucideIconSet();
  hydrateCustomRoles([
    { id: 'named', label: 'Named', color: '#123456', iconName: 'BookOpen', iconSvg: LUCIDE_DOM },
    { id: 'unknown', label: 'Unknown', color: '#123456', iconName: 'NoSuchIcon', iconSvg: LUCIDE_DOM },
    { id: 'proto', label: 'Proto', color: '#123456', iconName: '__proto__', iconSvg: LUCIDE_DOM },
  ], icons);
  assert.equal(resolveRole('named')?.icon, icons.BookOpen);
  assert.equal(resolveRole('named')?.iconSvg, CANONICAL);
  assert.equal(resolveRole('unknown')?.icon, undefined);
  assert.equal(resolveRole('proto')?.icon, undefined);
  assert.equal(lucideIconByName('constructor'), undefined);

  const named = renderToStaticMarkup(React.createElement(RoleSvg, { svg: '', iconName: 'BookOpen', size: 12 }));
  assert.match(named, /lucide-book-open/);
  const fallback = renderToStaticMarkup(React.createElement(RoleSvg, { svg: LUCIDE_DOM, iconName: 'NoSuchIcon' }));
  assert.match(fallback, /<circle cx="12" cy="12" r="3"><\/circle>/);
});

test('RoleSvg draws parsed shapes and nothing from rejected markup', () => {
  const clean = renderToStaticMarkup(React.createElement(RoleSvg, { svg: LUCIDE_DOM, size: 12 }));
  assert.match(clean, /<path d="M12 7v14"><\/path>/);
  assert.match(clean, /<g transform="translate\(1 1\)"><rect /);
  const armed = renderToStaticMarkup(React.createElement(RoleSvg, { svg: '<image href="x" onerror="alert(1)"/>' }));
  assert.doesNotMatch(armed, /image|onerror/);
});

test('appendRoleSvg builds SVG elements for the canvas, never parsing HTML', () => {
  const { document } = new JSDOM('<svg xmlns="http://www.w3.org/2000/svg"><g id="host"></g></svg>').window;
  const host = document.getElementById('host')!;
  appendRoleSvg(host, LUCIDE_DOM);
  assert.equal(host.children.length, 3);
  assert.equal(host.children[0]?.namespaceURI, 'http://www.w3.org/2000/svg');
  assert.equal(host.querySelector('rect')?.getAttribute('rx'), '2');
  const other = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  appendRoleSvg(other, '<image href="x" onerror="alert(1)"/><path d="M1 1"/>');
  assert.equal(other.children.length, 0);
});
