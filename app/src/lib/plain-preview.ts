/**
 * Inline markdown markers removed from a short text shown as plain text.
 *
 * Notifications are written by agents, often in markdown, and a card that
 * prints its text raw showed literal asterisks and backticks, cut in half by
 * the line clamp (`**Actio…`). Only the inline markers go: the words stay,
 * line breaks stay, and a lone `*` used as a bullet or a multiplication keeps
 * its meaning.
 */
export function plainPreview(text: string): string {
  return text
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '$1')
    .replace(/__(?=\S)([\s\S]*?\S)__/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    // A pair the clamp or the sender left open: the marker alone is noise.
    .replace(/\*\*/g, '');
}
