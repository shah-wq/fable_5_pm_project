import { createServerClient } from '@supabase/ssr';
import { createClient as createBareClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import type { Database } from '../database.types';
import { supabasePublishableKey, supabaseSecretKey, supabaseUrl } from './env';
import type { TypedClient } from './types';

/**
 * Server client bound to the request's cookie session (server components,
 * route handlers, server actions). RLS applies with the user's role.
 */
export async function createSupabaseServer(): Promise<TypedClient> {
  const cookieStore = await cookies();
  return createServerClient<Database>(
    supabaseUrl(),
    supabasePublishableKey(),
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Called from a Server Component: session refresh is handled by
            // middleware, so failing to persist here is fine.
          }
        },
      },
    }
  );
}

/**
 * Anonymous client with no session — for public code paths that must never
 * see a user's cookies (e.g. validating /u/<token> upload grants).
 */
export function createAnonClient(): TypedClient {
  return createBareClient<Database>(supabaseUrl(), supabasePublishableKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Service-role client for trusted server-side work (auth admin API, no-login
 * grant uploads). Bypasses RLS — keep it inside route handlers that have done
 * their own authorization, and never ship the key to the browser.
 */
export function createServiceClient(): TypedClient {
  return createBareClient<Database>(supabaseUrl(), supabaseSecretKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
