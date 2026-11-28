export type TextPart = { kind: 'text'; text: string } | { kind: 'link'; text: string; href: string };

const URL_RE = /https?:\/\/[^\s<>"']+/gi;
// Sentence punctuation right after a URL belongs to the sentence, not the link.
const TRAILING = /[.,;:!?)\]}]+$/;

/** Splits plain text into text and http(s) link parts. Other schemes stay text. */
export function splitLinks(input: string): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  for (const m of input.matchAll(URL_RE)) {
    const start = m.index ?? 0;
    const url = m[0].replace(TRAILING, '');
    if (!/^https?:\/\/[^/]/i.test(url)) continue;
    if (start > last) parts.push({ kind: 'text', text: input.slice(last, start) });
    parts.push({ kind: 'link', text: url, href: url });
    last = start + url.length;
  }
  if (last < input.length) parts.push({ kind: 'text', text: input.slice(last) });
  return parts;
}
