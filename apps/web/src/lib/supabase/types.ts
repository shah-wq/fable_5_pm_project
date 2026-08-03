import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../database.types';

/** A supabase-js client typed against the generated schema. */
export type TypedClient = SupabaseClient<Database>;
