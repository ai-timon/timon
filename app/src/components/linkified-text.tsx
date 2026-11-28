import { splitLinks } from '@/lib/linkify';

/** Plain text whose http(s) URLs are links; no HTML is injected. A click on a link never reaches the parent (a card must not open). */
export function LinkifiedText({ text }: { text: string }) {
  return (
    <>
      {splitLinks(text).map((p, i) =>
        p.kind === 'text' ? (
          <span key={i}>{p.text}</span>
        ) : (
          <a
            key={i}
            href={p.href}
            target="_blank"
            rel="noopener noreferrer"
            className="underline break-all"
            onClick={(e) => e.stopPropagation()}
          >
            {p.text}
          </a>
        ),
      )}
    </>
  );
}
