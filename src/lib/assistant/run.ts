import Anthropic from '@anthropic-ai/sdk';
import type { SessionIdentity } from '../db';
import { reportFieldCatalog, serialiseResult, toolsFor } from './tools';

/**
 * Ask SolarFlow: one question, answered from live data.
 *
 * A manual tool loop over the Messages API. The model reads through the tools
 * in tools.ts, every one of which runs under the asker's own claims, so the
 * answer can only contain what that person could have found on the screens.
 *
 * Model and effort: Claude Opus 5 by default (ASSISTANT_MODEL overrides it),
 * adaptive thinking, effort from ASSISTANT_EFFORT (default medium — this is a
 * chat, and people are waiting). Server-side fallbacks are on: if the model's
 * safety classifiers decline a request, the API retries it on the model
 * Anthropic recommends for that case instead of returning a refusal.
 *
 * The conversation is kept by the browser and sent whole each time as plain
 * text turns; tool calls from earlier questions are not replayed. That keeps
 * each request small and means nothing is stored server-side.
 */

export const DEFAULT_MODEL = 'claude-opus-5';
const MAX_TOOL_ROUNDS = 8;
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
type Effort = (typeof EFFORTS)[number];

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export type AssistantEvent =
  | { type: 'status'; text: string }
  | { type: 'answer'; text: string; tools: string[] }
  | { type: 'error'; error: string };

export function assistantConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

function linkRule(role: string): string {
  if (role === 'admin' || role === 'ops' || role === 'designer' || role === 'finance') {
    return 'When you mention a project whose id you have, link its code: [PRJ-1234ABCD](/projects/<id>).';
  }
  if (role === 'dealer') {
    return 'When you mention a project whose id you have, link its code: [PRJ-1234ABCD](/dealers/projects/<id>).';
  }
  return 'Do not link projects; this user opens them from the Deals board.';
}

/** The stable part of the prompt — the same for everyone with this role, so it caches. */
function stablePrompt(identity: SessionIdentity, reporting: boolean): string {
  return [
    'You are Ask SolarFlow, the assistant inside SolarFlow PM — the project-management and CRM system of a residential solar installer. Staff and dealers ask you about projects, stages, customers, deals, workload and performance. Your tools read the live database with the asking person’s own permissions, so whatever they return is exactly what this person is allowed to see.',
    '',
    'How to answer:',
    '- Use the tools to get facts; answer only from what they return. If the data does not say, say so plainly. Never invent a project, a name, a figure or a date.',
    '- You cannot change anything. When someone asks you to move, edit, send or delete, tell them where in the app to do it.',
    '- Lead with the answer. Keep it short: a sentence or two, then a bulleted list or a markdown table when there are several items. Name projects by code and customer.',
    `- ${linkRule(identity.role)} Only link to paths that start with “/”.`,
    '- For a “PM report”, cover each PM’s active and on-hold count, what is ageing, what is blocked and why, and customer messages waiting; end with the two or three things most worth doing next.',
    '- If a tool returns an error or nothing, try once more with broader filters before saying there is nothing.',
    '',
    'The business:',
    '- Delivery stages, in order: Survey → Design → Permits → Procurement → Install → Inspection & PTO → Complete. On hold and Cancelled are side states a project can be put in and taken out of.',
    '- Each stage has a form; a project cannot advance until the form’s required fields and required attachments are in. “Missing to advance” lists exactly what is outstanding.',
    '- “Ageing” means an active project has been in its stage longer than that stage’s threshold (Admin → Settings).',
    '- Contact stages (sales): created, appointment scheduled, appointment rescheduled, no-show, quoted, financing approved, contract signed, lost. Signing a contact creates the project at Survey.',
    '- Deal stages: new, contacted, qualified, proposal, negotiation, contract out, won, lost.',
    '- Change orders adjust a signed contract; once signed or approved their amount is part of the contract value.',
    ...(reporting
      ? [
          '',
          'run_report field keys available to this user (key | label | type | groupable):',
          reportFieldCatalog(identity),
        ]
      : []),
  ].join('\n');
}

function client(): Anthropic {
  // ANTHROPIC_BASE_URL, when set, is read by the SDK itself (the test suite
  // points it at a local stand-in).
  return new Anthropic({ maxRetries: 2, timeout: 120_000 });
}

function effort(): Effort {
  const e = process.env.ASSISTANT_EFFORT as Effort | undefined;
  return e && (EFFORTS as readonly string[]).includes(e) ? e : 'medium';
}

/**
 * Answer the last user turn of `history`. `emit` receives progress lines while
 * the tools run, then the answer (or an error).
 */
export async function ask(
  identity: SessionIdentity & { name?: string | null },
  history: ChatTurn[],
  emit: (e: AssistantEvent) => void
): Promise<{
  answer: string;
  tools: string[];
  usage: { input: number; output: number; cacheRead: number };
}> {
  const tools = toolsFor(identity.role);
  const reporting = tools.some((t) => t.definition.name === 'run_report');
  const byName = new Map(tools.map((t) => [t.definition.name, t]));
  const today = new Date().toISOString().slice(0, 10);

  const system: Anthropic.Beta.BetaTextBlockParam[] = [
    { type: 'text', text: stablePrompt(identity, reporting), cache_control: { type: 'ephemeral' } },
    // After the breakpoint: it changes daily and per person.
    {
      type: 'text',
      text: `Today is ${today}. You are talking to ${identity.name ?? 'a user'} (role: ${identity.role}).`,
    },
  ];
  const messages: Anthropic.Beta.BetaMessageParam[] = history.map((t) => ({
    role: t.role,
    content: t.content,
  }));
  const used: string[] = [];
  const usage = { input: 0, output: 0, cacheRead: 0 };
  const api = client();

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const response = await api.beta.messages.create({
      model: process.env.ASSISTANT_MODEL || DEFAULT_MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      thinking: { type: 'adaptive' },
      output_config: { effort: effort() },
      system,
      tools: tools.map((t) => t.definition),
      messages,
    });
    usage.input += response.usage.input_tokens ?? 0;
    usage.output += response.usage.output_tokens ?? 0;
    usage.cacheRead += response.usage.cache_read_input_tokens ?? 0;

    if (response.stop_reason === 'refusal') {
      const text =
        'I can’t help with that one. Try asking about a project, a stage, a dealer or a report.';
      emit({ type: 'answer', text, tools: used });
      return { answer: text, tools: used, usage };
    }
    if (response.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: response.content });
      continue;
    }

    const calls = response.content.filter(
      (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use'
    );
    if (response.stop_reason !== 'tool_use' || calls.length === 0 || round === MAX_TOOL_ROUNDS) {
      const text = response.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      const answer =
        text ||
        (round === MAX_TOOL_ROUNDS
          ? 'That needed more lookups than I am allowed for one question. Try narrowing it — one PM, one dealer or one stage.'
          : 'I could not put an answer together. Try rephrasing the question.');
      emit({ type: 'answer', text: answer, tools: used });
      return { answer, tools: used, usage };
    }

    // The whole assistant turn goes back, thinking blocks included: the API
    // needs them unchanged to continue the same turn.
    messages.push({ role: 'assistant', content: response.content });
    const labels = [...new Set(calls.map((c) => byName.get(c.name)?.label ?? 'Looking that up'))];
    emit({ type: 'status', text: `${labels.join(', ')}…` });

    // Each tool runs on its own connection (withUser), so they can run at once.
    const results = await Promise.all(
      calls.map(async (call): Promise<Anthropic.Beta.BetaToolResultBlockParam> => {
        const tool = byName.get(call.name);
        used.push(call.name);
        if (!tool) {
          return {
            type: 'tool_result',
            tool_use_id: call.id,
            is_error: true,
            content: `No tool named ${call.name}.`,
          };
        }
        const input =
          call.input && typeof call.input === 'object' && !Array.isArray(call.input)
            ? (call.input as Record<string, unknown>)
            : {};
        try {
          return {
            type: 'tool_result',
            tool_use_id: call.id,
            content: serialiseResult(await tool.run(identity, input)),
          };
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          console.error(`[assistant] ${call.name} failed:`, message);
          return {
            type: 'tool_result',
            tool_use_id: call.id,
            is_error: true,
            content: `The lookup failed: ${message.slice(0, 300)}`,
          };
        }
      })
    );
    // All results in one user message, as the API expects for parallel calls.
    messages.push({ role: 'user', content: results });
  }
  // Unreachable: the last round always answers.
  throw new Error('assistant loop ended without an answer');
}

/** A person-readable reason for an API failure, without leaking internals. */
export function describeApiError(e: unknown): { status: number; error: string } {
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
    return { status: 503, error: 'The assistant is not connected — check ANTHROPIC_API_KEY.' };
  }
  if (e instanceof Anthropic.RateLimitError) {
    return { status: 429, error: 'The assistant is busy right now. Try again in a minute.' };
  }
  if (e instanceof Anthropic.BadRequestError) {
    return {
      status: 502,
      error: 'The assistant could not process that question. Try rephrasing it.',
    };
  }
  if (e instanceof Anthropic.APIConnectionError) {
    return { status: 502, error: 'Could not reach the assistant service. Try again shortly.' };
  }
  if (e instanceof Anthropic.APIError) {
    return {
      status: 502,
      error: `The assistant service had a problem (${e.status ?? 'unknown'}). Try again shortly.`,
    };
  }
  return { status: 500, error: 'Something went wrong answering that.' };
}
