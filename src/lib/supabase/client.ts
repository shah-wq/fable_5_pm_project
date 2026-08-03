'use client';

import { createBrowserClient } from '@supabase/ssr';
import type { Database } from '../database.types';
import { supabasePublishableKey, supabaseUrl } from './env';

/**
 * Browser client (publishable key + the user's cookie session). RLS is the
 * authorization layer — each role sees exactly its §2 slice.
 */
export function createClient() {
  return createBrowserClient<Database>(supabaseUrl(), supabasePublishableKey());
}
