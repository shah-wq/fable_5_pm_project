'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { DETAIL_BLOCKS, type RefKey, type RefOption } from '@/lib/projects/details';
import { DetailsFields, type DetailRefs, type DetailValues } from '../../_components/DetailsFields';

/**
 * The New Project form — four blocks from the spec. Only customer name, site
 * address, and dealer block the Create button; everything else is optional
 * here and editable later from the Details tab.
 */
export function NewProjectForm({
  refs: initialRefs,
  defaultPm,
}: {
  refs: DetailRefs;
  defaultPm: string;
}) {
  const router = useRouter();
  const [refs, setRefs] = useState(initialRefs);
  const [values, setValues] = useState<DetailValues>({ assigned_pm: defaultPm });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const canCreate =
    String(values.first_name ?? '').trim() &&
    String(values.last_name ?? '').trim() &&
    String(values.address ?? '').trim() &&
    values.dealer_id;

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          customerFirst: values.first_name,
          customerLast: values.last_name,
          customerEmail: values.email,
          customerPhone: values.phone,
          address: values.address,
          dealerId: values.dealer_id,
          financePartnerId: values.finance_partner_id || undefined,
          systemSizeKw: values.system_size_kw ? Number(values.system_size_kw) : undefined,
          contractValue: values.contract_value ? Number(values.contract_value) : undefined,
          assignedPm: values.assigned_pm,
          details: {
            sales_rep_id: values.sales_rep_id ?? null,
            system_type_id: values.system_type_id ?? null,
            module_type_id: values.module_type_id ?? null,
            module_quantity: values.module_quantity ? Number(values.module_quantity) : null,
            inverter_type_id: values.inverter_type_id ?? null,
            inverter_quantity: values.inverter_quantity ? Number(values.inverter_quantity) : null,
            battery_type_id: values.battery_type_id ?? null,
            battery_quantity: values.battery_quantity ? Number(values.battery_quantity) : null,
            cash_or_financing_id: values.cash_or_financing_id ?? null,
            financing_company_id: values.financing_company_id ?? null,
            financing_notes: values.financing_notes ?? null,
          },
        }),
      });
      const json = await res.json().catch(() => null);
      if (res.ok && json?.projectId) {
        router.replace(`/projects/${json.projectId}`);
        router.refresh();
        return;
      }
      setError(json?.error ?? `Could not create the project (${res.status}).`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="stack-form" onSubmit={onSubmit}>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {DETAIL_BLOCKS.map((block) => (
        <section className="panel" key={block.key}>
          <h2>{block.title}</h2>
          <DetailsFields
            block={block}
            values={values}
            refs={refs}
            onChange={(name, value) => setValues((v) => ({ ...v, [name]: value }))}
            onRefAdded={(key: RefKey, option: RefOption) =>
              setRefs((r) => ({ ...r, [key]: [...r[key], option].sort((a, b) => a.name.localeCompare(b.name)) }))
            }
          />
        </section>
      ))}
      <button className="btn" type="submit" disabled={busy || !canCreate}>
        {busy ? 'Creating…' : 'Create project'}
      </button>
      {!canCreate && (
        <p className="dim">Customer name, site address, and dealer are all the Create button needs.</p>
      )}
    </form>
  );
}
