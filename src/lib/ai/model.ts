import Anthropic from '@anthropic-ai/sdk';
import { DEFAULT_MODEL } from '../assistant/run';

/**
 * The model call the automation jobs share. Same model and fallbacks as Ask
 * SolarFlow (ASSISTANT_MODEL overrides), no tools, one turn: these jobs hand
 * the model everything it needs and ask for JSON back.
 *
 * Effort is low by default: reading a permit letter or drafting a two-line
 * reply is not a hard problem, and these run on every upload. AI_EFFORT
 * overrides it.
 */

export function aiConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
type Effort = (typeof EFFORTS)[number];
function effort(): Effort {
  const e = process.env.AI_EFFORT as Effort | undefined;
  return e && (EFFORTS as readonly string[]).includes(e) ? e : 'low';
}

let api: Anthropic | null = null;
function client(): Anthropic {
  // ANTHROPIC_BASE_URL is read by the SDK (the test suite points it at a stand-in).
  return (api ??= new Anthropic({ maxRetries: 2, timeout: 90_000 }));
}

export type Block = Anthropic.Beta.BetaContentBlockParam;

/** A PDF or image as a content block, for the model to read directly. */
export function fileBlock(mime: string, bytes: Buffer): Block | null {
  const data = bytes.toString('base64');
  if (mime === 'application/pdf') {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } };
  }
  if (
    mime === 'image/jpeg' ||
    mime === 'image/png' ||
    mime === 'image/webp' ||
    mime === 'image/gif'
  ) {
    return { type: 'image', source: { type: 'base64', media_type: mime, data } };
  }
  return null;
}

/**
 * One turn: system + user content → the text of the reply. The system block is
 * marked for caching, because every read_document job for the same stage
 * shares it.
 */
export async function complete(
  system: string,
  content: string | Block[],
  opts: { maxTokens?: number } = {}
): Promise<{ text: string; usage: { input: number; output: number; cacheRead: number } }> {
  const response = await client().beta.messages.create({
    model: process.env.ASSISTANT_MODEL || DEFAULT_MODEL,
    max_tokens: opts.maxTokens ?? 4000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    thinking: { type: 'adaptive' },
    output_config: { effort: effort() },
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content }],
  });
  if (response.stop_reason === 'refusal') {
    throw new Error('the model declined to process this content');
  }
  const text = response.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
  return {
    text,
    usage: {
      input: response.usage.input_tokens ?? 0,
      output: response.usage.output_tokens ?? 0,
      cacheRead: response.usage.cache_read_input_tokens ?? 0,
    },
  };
}

/** The first JSON object in a reply, fences and prose tolerated. */
export function parseJsonObject<T = Record<string, unknown>>(text: string): T | null {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

/** A short, safe description of why a call failed, for the job's error column. */
export function describeFailure(e: unknown): { message: string; retry: boolean } {
  if (e instanceof Anthropic.RateLimitError || e instanceof Anthropic.APIConnectionError) {
    return { message: e.message.slice(0, 300), retry: true };
  }
  if (e instanceof Anthropic.APIError && (e.status ?? 0) >= 500) {
    return { message: `API ${e.status}: ${e.message}`.slice(0, 300), retry: true };
  }
  return { message: (e instanceof Error ? e.message : String(e)).slice(0, 300), retry: false };
}
