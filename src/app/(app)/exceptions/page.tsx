import { guardPath } from '@/lib/auth/session';
import { ExceptionsList } from './ExceptionsList';

export const dynamic = 'force-dynamic';

/**
 * The exceptions queue: everything the system could not settle on its own and
 * needs a person for. Today that is mostly the document reader — values it
 * found but is not sure enough to write, and documents that do not look like
 * what they were filed as — plus anything raised by hand or by other checks.
 * Deciding here writes the form; there is no second place to go.
 */
export default async function ExceptionsPage() {
  await guardPath('/exceptions');
  return (
    <main className="table-page exceptions-page">
      <div className="board-header">
        <div>
          <h1>Exceptions</h1>
          <p className="dim">
            What the automation could not decide on its own. Accept a value and it is written to the
            stage form; reject it and nothing changes. Resolving an exception closes anything still
            undecided without applying it.
          </p>
        </div>
      </div>
      <ExceptionsList />
    </main>
  );
}
