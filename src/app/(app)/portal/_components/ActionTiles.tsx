import Link from 'next/link';

/**
 * The two tiles under the card (§3): message the project manager, and the
 * documents.
 *
 * Both are named and quantified, which is the point. 'Ask a question' is a form;
 * 'Ask Shah' is a person who can answer, and §6 is right that a named person
 * feels answerable in a way a form does not. 'Documents · 6 files' tells somebody
 * whether tapping is worth it; 'Documents' alone does not.
 *
 * The reply promise sits under the message tile deliberately: a customer who
 * knows the rhythm waits, and one who assumes live chat phones the office after
 * twenty minutes — which is the call this whole feature exists to prevent.
 */
export function ActionTiles({
  pmName,
  replyPromise,
  documentCount,
  /**
   * Unread messages. Optional and normally left out: the Messages tab in the bar
   * below already carries the badge, and two counts for the same thing on one
   * screen is one of them being wrong eventually.
   */
  unread = 0,
}: {
  pmName: string | null;
  replyPromise: string | null;
  documentCount: number;
  unread?: number;
}) {
  return (
    <div className="action-tiles rise" style={{ '--delay': '420ms' } as React.CSSProperties}>
      <Link className="tile" href="/portal/messages">
        <span className="tile-title">
          {pmName ? `Ask ${firstName(pmName)}` : 'Ask your project manager'}
          {unread > 0 && <span className="tile-badge">{unread}</span>}
        </span>
        <span className="tile-sub">{replyPromise ?? 'Replies within one business day'}</span>
      </Link>
      <Link className="tile" href="/portal/documents">
        <span className="tile-title">Documents</span>
        <span className="tile-sub">
          {documentCount === 0
            ? 'Nothing to see yet'
            : `${documentCount} ${documentCount === 1 ? 'file' : 'files'}`}
        </span>
      </Link>
    </div>
  );
}

/**
 * 'Ask Casey', not 'Ask Casey Chen'. A first name is how somebody would say it
 * out loud, and it keeps the tile to one line on a 360px screen.
 */
function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}
