'use client';

import { useRouter } from 'next/navigation';
import { SuggestionRows, type SuggestionItem } from '@/app/(app)/_components/SuggestionRows';

/**
 * The document reader's proposals for this stage, above the form. Accepting
 * one writes it and refreshes the page, so the form below shows the new value.
 */
export function AiSuggestions({ items }: { items: SuggestionItem[] }) {
  const router = useRouter();
  if (items.length === 0) return null;
  return (
    <section className="panel ai-panel">
      <h2>
        Read from the attachments
        <span className="chip"> {items.length} to confirm</span>
      </h2>
      <p className="dim small">
        The assistant read the documents attached to this stage and found these values. Nothing is
        written until you accept it.
      </p>
      <SuggestionRows items={items} compact onChanged={() => router.refresh()} />
    </section>
  );
}
