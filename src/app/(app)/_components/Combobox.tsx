'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { RefOption } from '@/lib/projects/details';

/**
 * Type-ahead combobox for long reference lists (79 modules, 71 batteries…) —
 * a plain select is unusable at that length. Stores the option's ID, shows
 * its text; typing filters, Enter/click picks, clearing the text clears the
 * value.
 */
export function Combobox({
  options,
  value,
  onChange,
  placeholder,
  fallbackLabel,
}: {
  options: RefOption[];
  value: string | null;
  onChange: (id: string | null) => void;
  placeholder?: string;
  /** Label for a value not in the (active) options — e.g. a deactivated row. */
  fallbackLabel?: string | null;
}) {
  const selected = options.find((o) => o.id === value);
  const selectedLabel = selected?.name ?? (value ? (fallbackLabel ?? '(inactive option)') : '');
  const [text, setText] = useState(selectedLabel);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  // Keep the input in sync when the value changes from outside.
  useEffect(() => setText(selectedLabel), [selectedLabel]);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) {
        setOpen(false);
        setText(selectedLabel);
      }
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [selectedLabel]);

  const filtered = useMemo(() => {
    const q = text.trim().toLowerCase();
    if (!q || q === selectedLabel.toLowerCase()) return options;
    return options.filter((o) => o.name.toLowerCase().includes(q));
  }, [options, text, selectedLabel]);

  function pick(option: RefOption) {
    onChange(option.id);
    setText(option.name);
    setOpen(false);
  }

  return (
    <div className="combobox" ref={rootRef}>
      <input
        type="text"
        role="combobox"
        aria-expanded={open}
        value={text}
        placeholder={placeholder ?? 'Type to search…'}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
          setHighlight(0);
          if (e.target.value.trim() === '') onChange(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setHighlight((h) => Math.min(h + 1, filtered.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setHighlight((h) => Math.max(h - 1, 0));
          } else if (e.key === 'Enter' && open && filtered[highlight]) {
            e.preventDefault();
            pick(filtered[highlight]);
          } else if (e.key === 'Escape') {
            setOpen(false);
            setText(selectedLabel);
          }
        }}
      />
      {open && (
        <ul className="combobox-list" role="listbox">
          {filtered.slice(0, 40).map((o, i) => (
            <li
              key={o.id}
              role="option"
              aria-selected={o.id === value}
              className={`${i === highlight ? 'highlight' : ''}${o.id === value ? ' selected' : ''}`}
              onMouseEnter={() => setHighlight(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(o);
              }}
            >
              {o.name}
            </li>
          ))}
          {filtered.length === 0 && <li className="dim">No match.</li>}
          {filtered.length > 40 && <li className="dim">…{filtered.length - 40} more — keep typing.</li>}
        </ul>
      )}
    </div>
  );
}
