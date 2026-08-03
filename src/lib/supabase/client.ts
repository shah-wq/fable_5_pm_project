import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../database.types';

/** A supabase-js client typed against the generated schema. */
export type TypedClient = SupabaseClient<Database>;

export interface ClientConfig {
  url?: string;
  key?: string;
}

/**
 * Client for user-facing code paths (anon key + the user's JWT). RLS is the
 * authorization layer, so this client can be handed to any module: each role
 * sees exactly its §2 slice.
 */
export function createSupabaseClient(config: ClientConfig = {}): TypedClient {
  const url = config.url ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = config.key ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error(
      'Supabase URL and anon key are required (NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY).'
    );
  }
  return createClient<Database>(url, key);
}

/**
 * Service-role client for trusted server-side jobs (queue workers, webhooks).
 * Bypasses RLS — never expose it to request handlers that act on behalf of a
 * user, and never ship the key to the browser.
 */
export function createServiceClient(config: ClientConfig = {}): TypedClient {
  const url = config.url ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = config.key ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      'Supabase URL and service-role key are required (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).'
    );
  }
  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
