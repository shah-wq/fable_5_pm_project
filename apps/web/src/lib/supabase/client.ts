'use client';

import { createBrowserClient } from '@supabase/ssr';
import type { Database } from '../database.types';

/**
 * Browser client (anon key + the user's cookie session). RLS is the
 * authorization layer — each role sees exactly its §2 slice.
 */
export function createClient() {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
