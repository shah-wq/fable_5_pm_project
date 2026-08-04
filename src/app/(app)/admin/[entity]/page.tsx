import { notFound } from 'next/navigation';
import { ADMIN_ENTITIES } from '@/lib/admin/entities';
import { guardPath } from '@/lib/auth/session';
import { withUser } from '@/lib/db';
import { AdminTabs } from '../_components/AdminTabs';
import { RecordManager } from '../_components/RecordManager';

export const dynamic = 'force-dynamic';

/** One page serves every reference-table section, driven by the registry. */
export default async function AdminEntityPage({
  params,
}: {
  params: Promise<{ entity: string }>;
}) {
  const { entity } = await params;
  const def = ADMIN_ENTITIES[entity];
  if (!def) notFound();

  const session = await guardPath('/admin');

  const cols = ['id', 'is_active', ...def.fields.map((f) => `"${f.name}"`)].join(', ');
  const { rows } = await withUser(session, (c) =>
    c.query(`select ${cols} from public."${def.table}" order by "${def.nameColumn}"`)
  );

  return (
    <main className="table-page">
      <h1>Admin</h1>
      <AdminTabs />
      <h2 className="section-title">{def.title}</h2>
      <p className="dim">{def.blurb}</p>
      <RecordManager
        entity={entity}
        nameColumn={def.nameColumn}
        fields={def.fields}
        listColumns={def.listColumns}
        rows={rows}
      />
    </main>
  );
}
