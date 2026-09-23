import { guardPath } from '@/lib/auth/session';
import { AdminTabs } from '../_components/AdminTabs';
import { AiSettings } from './AiSettings';

export const dynamic = 'force-dynamic';

export default async function AdminAiPage() {
  await guardPath('/admin');
  return (
    <main className="table-page">
      <h1>Admin</h1>
      <AdminTabs />
      <h2 className="section-title">AI automation</h2>
      <p className="dim">
        What the assistant does on its own. Every switch starts on the cautious side: it reads and
        proposes, and a person decides. Turn on auto-apply and auto-send when the proposals have
        earned it. The model connection is the ANTHROPIC_API_KEY environment variable — the same one
        Ask SolarFlow uses.
      </p>
      <AiSettings />
    </main>
  );
}
