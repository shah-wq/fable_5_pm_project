// Prints, as JSON, every stage-form field that is saved to a stage table:
// { stage1_survey: ["down_payment_status", …], … }. The e2e suite compares it
// with information_schema, so a field on the form without a column (or a
// typo in either) fails a test rather than a PM's save.
import { STAGE_FORMS, STAGE_TABLES } from '../../src/lib/stages/fields.ts';

const out = {};
for (const [stage, cards] of Object.entries(STAGE_FORMS)) {
  const table = STAGE_TABLES[stage];
  out[table] = [
    ...new Set(
      cards
        .flatMap((c) => c.fields)
        .filter((f) => f.type !== 'upload' && (f.table ?? 'stage') === 'stage')
        .map((f) => f.name)
    ),
  ];
}
process.stdout.write(JSON.stringify(out));
