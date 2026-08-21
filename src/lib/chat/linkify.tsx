/**
 * Plain text with automatic link detection (Project Chat §3) — "no rich
 * formatting; it adds complexity and customers do not use it".
 *
 * Built as React elements rather than by assembling an HTML string, and
 * restricted to http(s), so a message body can never introduce markup or a
 * javascript: URL. Message bodies come from customers, which is exactly the
 * input you do not want interpreted.
 *
 * In its own module, with no 'use client', because both the live thread (a client
 * component) and the printable transcript (a server component) render message
 * bodies. Exported from the client component it would be unreachable from the
 * server — which is how the transcript first came to 500.
 */

const URL_RE = /(https?:\/\/[^\s<>"')\]]+)/g;

export function linkify(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  text.split('\n').forEach((line, lineIndex) => {
    if (lineIndex > 0) out.push(<br key={`br-${lineIndex}`} />);
    const parts = line.split(URL_RE);
    parts.forEach((part, i) => {
      if (i % 2 === 1) {
        // Trailing punctuation is far more often the end of a sentence than part
        // of the URL.
        const trimmed = part.replace(/[.,;:!?]+$/, '');
        const tail = part.slice(trimmed.length);
        out.push(
          <a key={`l-${lineIndex}-${i}`} href={trimmed} target="_blank" rel="noreferrer noopener">
            {trimmed}
          </a>
        );
        if (tail) out.push(tail);
      } else if (part) {
        out.push(part);
      }
    });
  });
  return out;
}
