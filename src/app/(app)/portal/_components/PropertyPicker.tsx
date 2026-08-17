'use client';

import { usePathname, useRouter } from 'next/navigation';

/**
 * A customer with two properties — a second home, a rental — switches between
 * them here. It stays on the current tab, because someone comparing documents
 * for two houses should not be bounced back to Home each time.
 */
export function PropertyPicker({
  projects,
  current,
}: {
  projects: Array<{ id: string; label: string }>;
  current: string;
}) {
  const router = useRouter();
  const pathname = usePathname();

  return (
    <label className="property-picker">
      <span className="dim">Property</span>
      <select
        value={current}
        onChange={(e) => router.push(`${pathname}?project=${e.target.value}`)}
      >
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </select>
    </label>
  );
}
