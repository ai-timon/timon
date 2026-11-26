const BLOCKS = new Set(['BLOCKQUOTE', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'OL', 'P', 'PRE', 'UL']);
const INLINE_MARKERS: Readonly<Record<string, string>> = {
  B: '**', STRONG: '**', I: '*', EM: '*', DEL: '~~', S: '~~',
};

export function trimBlankLines(text: string): string {
  return text.replace(/^\s*[\r\n]|[\r\n]\s*$/g, '');
}

function literal(text: string): string {
  return text
    .replace(/[\\`*_~[\]<>]/g, '\\$&')
    .replace(/&(?=(?:#\w+|[a-z][\da-z]*);)/gi, '\\&')
    .replace(/^(\s*)([#|+\-=])/gm, '$1\\$2')
    .replace(/^(\s*\d{1,9})([.)])(?=[ \t])/gm, '$1\\$2');
}

function backticks(text: string, minimum: number) {
  let width = minimum;
  for (const [run] of text.matchAll(/`+/g)) width = Math.max(width, run.length + 1);
  return '`'.repeat(width);
}

function inlineCode(value: string) {
  const text = value.replace(/\r\n?|\n/g, ' ');
  const fence = backticks(text, 1);
  const pad = /^`|`$/.test(text) || (text.startsWith(' ') && text.endsWith(' ') && text.trim()) ? ' ' : '';
  return text ? fence + pad + text + pad + fence : '';
}

function children(node: Node): string {
  let result = '';
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE && !child.textContent?.trim() &&
        [child.previousSibling, child.nextSibling].some((sibling) => sibling instanceof Element && BLOCKS.has(sibling.tagName))) {
      continue;
    }
    const part = markdown(child);
    result += result.endsWith('\n\n') && part.startsWith('\n\n') ? part.slice(2) : part;
  }
  return result;
}

function list(element: Element) {
  let index = Number(element.getAttribute('start') ?? 1);
  const items = Array.from(element.children).filter((child) => child.tagName === 'LI');
  return items.map((item) => {
    const content = children(item).trim();
    if (!content) return '';
    const marker = element.tagName === 'OL' ? `${index++}. ` : '- ';
    return marker + content.replace(/\n(?=[^\n])/g, '\n' + ' '.repeat(marker.length));
  }).filter(Boolean).join('\n');
}

function markdown(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return literal((node.textContent ?? '').replace(/[\t\r\n ]+/g, ' '));
  if (!(node instanceof Element)) return children(node);

  const tag = node.tagName;
  if (tag === 'BUTTON' || tag === 'SCRIPT' || tag === 'STYLE' || tag === 'SVG') return '';
  if (tag === 'BR') return '  \n';
  if (tag === 'CODE') return inlineCode(node.textContent ?? '');
  if (tag === 'PRE') {
    const code = node.querySelector('code') ?? node;
    const value = trimBlankLines(code.textContent ?? '');
    const lang = node.getAttribute('data-lang') ?? code.getAttribute('class')?.match(/\blanguage-([\w+-]+)/)?.[1] ?? '';
    const info = /^[\w+-]+$/.test(lang) && lang !== 'plain' ? lang : '';
    const fence = backticks(value, 3);
    return `\n\n${fence}${info}\n${value}${value.endsWith('\n') ? '' : '\n'}${fence}\n\n`;
  }
  if (tag === 'OL' || tag === 'UL') {
    const content = list(node);
    return content ? `\n\n${content}\n\n` : '';
  }

  const content = children(node);
  const marker = INLINE_MARKERS[tag];
  if (marker) return content.replace(/^(\s*)(\S[\s\S]*?)(\s*)$/, `$1${marker}$2${marker}$3`);
  if (tag === 'A') {
    const href = node.getAttribute('href');
    if (href && !/[\u0000-\u0020<>\\]/.test(href) && (!/^[a-z][a-z\d+.-]*:/i.test(href) || /^(https?|mailto):/i.test(href))) {
      return content.replace(/^(\s*)(\S[\s\S]*?)(\s*)$/, (_, before, text, after) => `${before}[${text}](<${href}>)${after}`);
    }
    return content;
  }
  if (tag === 'BLOCKQUOTE') return `\n\n${content.trim().split('\n').map((line) => `> ${line}`).join('\n')}\n\n`;
  if (/^H[1-6]$/.test(tag) && content.trim()) return `\n\n${'#'.repeat(Number(tag[1]))} ${content.trim()}\n\n`;
  if (tag === 'P' || (tag === 'DIV' && !Array.from(node.children).some((child) => BLOCKS.has(child.tagName)))) {
    return content.trim() ? `\n\n${content.trim()}\n\n` : '';
  }
  return content;
}

export function selectionMarkdown(range: Range, source: Element, excerpt: string): string {
  let fragment: Element | DocumentFragment = range.cloneContents();
  // CloneContents preserves partial descendants. It omits common ancestors
  // such as a bold span or code block when the whole selection is inside one.
  const common = range.commonAncestorContainer;
  let parent = common instanceof Element ? common : common.parentElement;
  while (parent && parent !== source) {
    const wrapper = parent.cloneNode(false) as Element;
    if (parent.tagName === 'OL') {
      const first = Array.from(parent.children).findIndex((item) => item.contains(range.startContainer));
      if (first > 0) wrapper.setAttribute('start', String(Number(parent.getAttribute('start') ?? 1) + first));
    }
    wrapper.appendChild(fragment);
    fragment = wrapper;
    parent = parent.parentElement;
  }
  // Table selections may omit headers or columns. Keep the visible text in that case.
  if ((fragment instanceof Element && fragment.tagName === 'TABLE') || fragment.querySelector('table')) return literal(excerpt);
  const result = markdown(fragment).trim();
  return result || literal(excerpt);
}
