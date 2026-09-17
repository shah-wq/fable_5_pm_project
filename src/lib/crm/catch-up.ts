/**
 * What to paste, and in what order, when a database has not caught up.
 *
 * One list, because every screen that degrades says this sentence and three
 * versions of it would eventually name three different first files. It has
 * happened: the notices used to start at the CRM foundation, which fails on a
 * database that has not had the file before it — that one adds the 'sales' value
 * to the role type, and the foundation's own policies use it.
 *
 * "Each on its own" is the part people skip and the part that matters:
 * PostgreSQL will not let a transaction use an enum value it added itself, and
 * the SQL editor runs one paste as one transaction. Pasting all five together
 * fails with "unsafe use of new value sales" and nothing is applied.
 */
export const CRM_FILES = [
  'db/dist/20260803003300-add-sales-role.sql',
  'db/dist/20260803003400-crm-foundation.sql',
  'db/dist/20260803003500-deals.sql',
  'db/dist/20260803003600-contact-intake.sql',
  'db/dist/20260803003700-contact-create.sql',
] as const;

/** The first file, for a sentence that only has room for one. */
export const CRM_FIRST_FILE = CRM_FILES[0];

export const CRM_CATCH_UP =
  `Run these five files in the SQL editor, in this order, each as its own paste: ` +
  `${CRM_FILES.join(', then ')}. They are separate pastes on purpose — the first ` +
  `adds a value to a type that the second one uses, and PostgreSQL will not allow ` +
  `both in one transaction.`;
