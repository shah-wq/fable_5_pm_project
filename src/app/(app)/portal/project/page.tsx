import { loadPortalPage, NO_PROJECT_MESSAGE } from '@/lib/portal/page';
import { StageTracker } from '../StageTracker';
import { AvailabilityRequest } from '../_components/AvailabilityRequest';
import { PropertyPicker } from '../_components/PropertyPicker';

export const dynamic = 'force-dynamic';

/**
 * Project (spec §3.2). The full stage-by-stage detail, the system information,
 * and the agreed total with any approved changes.
 *
 * What is deliberately absent is the point of this screen: internal notes, day
 * counters, vendor and crew identities and costs are not merely hidden by the
 * template — loadCustomerProject never selects those columns, so a future
 * change here cannot leak them.
 */
export default async function PortalProject({
  searchParams,
}: {
  searchParams: Promise<{ project?: string }>;
}) {
  const { projects, project: p } = await loadPortalPage(searchParams);

  if (!p) {
    return (
      <div className="app-page">
        <h1>Your project</h1>
        <p className="notice hold">{NO_PROJECT_MESSAGE}</p>
      </div>
    );
  }

  const money = (n: number | null) =>
    n === null ? '—' : `$${n.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;

  const equipment: Array<[string, string]> = [
    p.system.sizeKw ? ['System size', `${p.system.sizeKw} kW`] : null,
    p.system.systemType ? ['System type', p.system.systemType] : null,
    p.system.modules
      ? ['Panels', `${p.system.modules}${p.system.moduleType ? ` × ${p.system.moduleType}` : ''}`]
      : null,
    p.system.inverters
      ? [
          'Inverter',
          `${p.system.inverters}${p.system.inverterType ? ` × ${p.system.inverterType}` : ''}`,
        ]
      : null,
    p.system.batteries
      ? [
          'Battery',
          `${p.system.batteries}${p.system.batteryType ? ` × ${p.system.batteryType}` : ''}`,
        ]
      : null,
  ].filter((row): row is [string, string] => row !== null);

  return (
    <div className="app-page">
      {projects.length > 1 && <PropertyPicker projects={projects} current={p.id} />}

      <h1>Your project in detail</h1>
      <p className="dim">
        {p.address} · {p.code}
      </p>

      <StageTracker stages={p.stages} />

      {/* Only while there is a visit still to arrange — a completed project
          does not need an appointment form. */}
      {!p.isComplete && !p.cancelled && (
        <AvailabilityRequest
          projectId={p.id}
          pmName={p.team.pmName}
          hasOpenRequest={p.openRequests.some(
            (r) => r.kind === 'availability' && r.status === 'open'
          )}
        />
      )}

      <section className="panel">
        <h2>Your system</h2>
        {equipment.length === 0 ? (
          <p className="dim">Your system details are being finalised.</p>
        ) : (
          <dl className="facts">
            {equipment.map(([label, value]) => (
              <span key={label} style={{ display: 'contents' }}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </span>
            ))}
          </dl>
        )}
      </section>

      <section className="panel">
        <h2>Your project total</h2>
        <dl className="facts">
          <dt>Agreed total</dt>
          <dd>{money(p.contractTotal)}</dd>
          {p.adders.map((a) => (
            <span key={a.name} style={{ display: 'contents' }}>
              <dt>{a.name}</dt>
              <dd>{money(a.amount)}</dd>
            </span>
          ))}
          {p.adders.length > 0 && (
            <>
              <dt>Current total</dt>
              <dd>
                <strong>{money(p.revisedTotal)}</strong>
              </dd>
            </>
          )}
        </dl>
        {p.adders.length > 0 && (
          <p className="dim">
            Changes shown here are the ones you have already approved. Nothing is added to your
            total without your agreement.
          </p>
        )}
      </section>

      <section className="panel">
        <h2>Payments</h2>
        <table className="projects-table">
          <thead>
            <tr>
              <th>Payment</th>
              <th>Status</th>
              <th>Received</th>
            </tr>
          </thead>
          <tbody>
            {p.payments.map((m) => (
              <tr key={m.label}>
                <td>{m.label}</td>
                <td>{m.status}</td>
                <td className="dim">{m.receivedOn ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {p.finance.company && (
          <>
            <h2>Your finance company</h2>
            <p>{p.finance.company}</p>
            <table className="projects-table">
              <tbody>
                {p.finance.milestones.map((m) => (
                  <tr key={m.label}>
                    <td>{m.label}</td>
                    <td>{m.status}</td>
                    <td className="dim">{m.receivedOn ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </section>
    </div>
  );
}
