#!/usr/bin/env node
// Generate src/lib/database.types.ts from a live database using the same
// generator the Supabase CLI uses (@supabase/postgres-meta), but without
// needing Docker. Prefer `npx supabase gen types typescript --local` when a
// full local stack is running; this script is the Docker-free fallback used
// by scripts/verify-local.sh environments and CI.
//
// Usage: DB_URL=postgresql://postgres@127.0.0.1:54322/postgres node scripts/gen-types.mjs > src/lib/database.types.ts

import { PostgresMeta } from '@supabase/postgres-meta';
import { apply } from '@supabase/postgres-meta/dist/server/templates/typescript.js';
import { getGeneratorMetadata } from '@supabase/postgres-meta/dist/lib/generators.js';

const connectionString = process.env.DB_URL;
if (!connectionString) {
  console.error('Set DB_URL to a postgres connection string.');
  process.exit(1);
}

const pgMeta = new PostgresMeta({ connectionString });
const { data, error } = await getGeneratorMetadata(pgMeta, {
  includedSchemas: ['public'],
  excludedSchemas: [],
});
if (error) {
  console.error(error);
  process.exit(1);
}

process.stdout.write(await apply({ ...data, detectOneToOneRelationships: true }));
process.exit(0);
