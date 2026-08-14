'use client';

import { useMemo, useState } from 'react';
import { CATEGORY_LABELS, type CategoryKey } from '@/lib/reports/fields';

export interface LibraryField {
  key: string;
  label: string;
  category: CategoryKey;
  type: string;
  groupable: boolean;
  summarisable: boolean;
  filterable: boolean;
}

const TYPE_ICON: Record<string, string> = {
  text: 'Ab', status: '◍', date: '▤', number: '#', currency: '$', boolean: '☑', count: '#',
};

/**
 * Left panel: every available field, grouped exactly as the stage forms are so
 * anyone who fills the forms knows where to look, with a search that filters
 * across all categories at once. Fields are dragged from here onto the canvas.
 */
export function FieldLibrary({
  fields,
  onDragField,
}: {
  fields: LibraryField[];
  /** Reports the field being dragged so the canvas can grey out zones that
   *  cannot accept it (the drag payload itself is unreadable mid-drag). */
  onDragField?: (field: LibraryField | null) => void;
}) {
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const grouped = useMemo(() => {
    const q = search.trim().toLowerCase();
    const map = new Map<CategoryKey, LibraryField[]>();
    for (const f of fields) {
      if (q && !f.label.toLowerCase().includes(q)) continue;
      const list = map.get(f.category) ?? [];
      list.push(f);
      map.set(f.category, list);
    }
    return map;
  }, [fields, search]);

  return (
    <aside className="report-panel">
      <input
        type="search"
        placeholder="Search fields…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <div className="field-list">
        {(Object.keys(CATEGORY_LABELS) as CategoryKey[]).map((category) => {
          const list = grouped.get(category);
          if (!list || list.length === 0) return null;
          const isOpen = !collapsed.has(category) || search.trim() !== '';
          return (
            <section key={category}>
              <button
                className="cat-head"
                type="button"
                onClick={() =>
                  setCollapsed((c) => {
                    const next = new Set(c);
                    if (next.has(category)) next.delete(category);
                    else next.add(category);
                    return next;
                  })
                }
              >
                <span>{isOpen ? '▾' : '▸'}</span>
                {CATEGORY_LABELS[category]}
                <span className="dim">{list.length}</span>
              </button>
              {isOpen && (
                <ul>
                  {list.map((f) => (
                    <li
                      key={f.key}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData('text/plain', f.key);
                        e.dataTransfer.effectAllowed = 'copy';
                        onDragField?.(f);
                      }}
                      onDragEnd={() => onDragField?.(null)}
                      title={`${f.label} · ${f.type}`}
                    >
                      <span className="type-icon">{TYPE_ICON[f.type] ?? '·'}</span>
                      {f.label}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
        {grouped.size === 0 && <p className="dim">No field matches “{search}”.</p>}
      </div>
    </aside>
  );
}
