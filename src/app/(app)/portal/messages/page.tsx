import { getSession } from '@/lib/auth/session';
import { chatReady, loadContext, loadThread } from '@/lib/chat/service';
import { withUser } from '@/lib/db';
import { loadPortalPage, NO_PROJECT_MESSAGE } from '@/lib/portal/page';
import { Thread } from '@/app/_components/Thread';
import { PropertyPicker } from '../_components/PropertyPicker';

export const dynamic = 'force-dynamic';

/**
 * The customer's side of the conversation — a Messages tab in the portal and the
 * same screen in the app (spec §1).
 *
 * Three things at the top, all from §4's aside about response-time expectations:
 * who they are talking to, by name, and the promise about when a reply comes.
 * "A customer who knows the rhythm waits patiently; one who assumes live chat
 * phones you after twenty minutes, which is exactly the call this feature was
 * meant to prevent."
 *
 * A homeowner with two projects gets two threads (§1), so the property picker is
 * here exactly as on the other tabs.
 */
export default async function PortalMessagesPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string; about?: string }>;
}) {
  const { projects, project } = await loadPortalPage(searchParams);
  const sp = await searchParams;
  const session = await getSession();

  if (!project || !session) {
    return (
      <div className="app-page">
        <section className="panel">
          <h1>Messages</h1>
          <p>{NO_PROJECT_MESSAGE}</p>
        </section>
      </div>
    );
  }

  const data = await withUser(
    { userId: session.userId, email: session.email, role: session.role },
    async (client) => ({
      // Probed first, on its own — see chatReady. A customer is never shown the
      // name of a migration file; they are told to phone instead, which is the
      // only thing they can usefully do.
      ready: await chatReady(client),
      context: await loadContext(client, project.id),
      thread: await loadThread(client, project.id, {
        viewerId: session.userId,
        staff: false,
        channel: 'customer',
      }),
    })
  );

  const pmName = data.context?.pmName ?? null;

  return (
    <div className="app-page">
      <PropertyPicker projects={projects} current={project.id} />

      <section className="panel chat-panel">
        <h1>Messages</h1>
        {/* §2: the PM is named at the top, so the customer knows who they are
            talking to — not 'Support'. */}
        <p className="dim">
          {pmName
            ? `You are talking to ${pmName}, the project manager for ${project.address ?? 'your project'}.`
            : 'Your project manager will reply here.'}
        </p>
        {/* §4: set a response-time expectation in the interface. */}
        <p className="reply-promise">
          {data.context?.replyPromise ?? 'We usually reply within one business day.'}
        </p>

        <Thread
          projectId={project.id}
          role="customer"
          channel="customer"
          initial={data.thread.messages}
          hasMore={data.thread.hasMore}
          recipientName={pmName}
          stageRef={sp.about ?? null}
          readOnlyReason={
            data.ready
              ? null
              : `Messaging is not available on your project yet. ${
                  pmName ? `Please call ${pmName}` : 'Please call your project manager'
                } and they will help straight away.`
          }
          // §8: an empty thread should invite the first message, not look broken.
          emptyState={
            pmName
              ? `Have a question about your project? Send a message and ${pmName} will reply.`
              : 'Have a question about your project? Send a message and your project manager will reply.'
          }
        />
      </section>
    </div>
  );
}
