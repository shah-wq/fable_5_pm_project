import { STAGES, stageIndex, type StageKey } from '../stages/definitions.ts';

/**
 * What the homeowner's home screen shows, derived once (Customer portal
 * redesign §2, §6, §7).
 *
 * Kept apart from the page and from the SQL because every function here is a
 * judgement about how to say something true — how far along is this, is that
 * panel count believable, which two words of an address does somebody recognise
 * as their own house. Those deserve tests, and a component is a bad place to
 * test them.
 *
 * Nothing here reads the database. The redesign is presentation only (§7): the
 * same rows the portal already loaded, arranged to answer three questions in
 * order — where am I, what happens next, is anything needed from me.
 */

/** A stage's typical length, from admin settings (migration 003100). */
export interface TypicalRange {
  min: number;
  max: number;
}

/**
 * How far along, as a percentage.
 *
 * Completed stages ÷ 7, flat. §7 is explicit about not weighting by expected
 * duration: a customer whose permit office is slow would watch the bar go
 * *backwards* as the estimate stretched, and no explanation makes that feel
 * like anything but a mistake. Equal stages are a small lie about effort and a
 * much smaller one than a bar that retreats.
 */
export function completionPercent(stage: StageKey, isComplete: boolean): number {
  if (isComplete) return 100;
  const done = stageIndex(stage);
  return Math.round((done / STAGES.length) * 100);
}

/** 'Stage 3 of 7' — the number under the ring. */
export function stagePosition(stage: StageKey): { index: number; total: number } {
  return { index: stageIndex(stage) + 1, total: STAGES.length };
}

const COUNTRY_WORDS = new Set([
  'usa',
  'us',
  'u.s.',
  'u.s.a.',
  'united states',
  'united states of america',
]);

/**
 * The city and state out of a free-text site address (§6).
 *
 * The bug this fixes: a homeowner in Tucson opened their project and read
 * 'USA' as their location. Nothing was corrupt — the address is one text field,
 * the country happened to be the last line, and the screen printed the last
 * line. Reading 'USA' where your own street should be is a small error that
 * costs disproportionate trust: it is your house, and the company building on
 * it appears not to know where it is.
 *
 * So: find the part that looks like a US state (two capitals, optionally with a
 * ZIP after it) and take the part before it as the city. Country words are
 * dropped wherever they appear. If nothing matches — an address in another
 * format, or a single line — the whole address is returned rather than a guess,
 * because showing somebody their own address is never wrong.
 */
export function cityState(address: string | null): string | null {
  if (!address) return null;
  const parts = address
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p && !COUNTRY_WORDS.has(p.toLowerCase()));
  if (parts.length === 0) return null;

  for (let i = parts.length - 1; i >= 0; i -= 1) {
    // 'TX', 'TX 85718', 'AZ 85718-1234'.
    const match = /^([A-Z]{2})(\s+\d{5}(-\d{4})?)?$/.exec(parts[i]);
    if (match && i > 0) return `${parts[i - 1]}, ${match[1]}`;
  }

  // No state found: the last remaining part is the most specific thing left
  // (a city, usually) unless the address never had commas at all.
  return parts.length > 1 ? parts[parts.length - 1] : parts[0];
}

/**
 * 'Tucson, AZ · 18 kW · 44 panels · 1 battery'.
 *
 * Two content fixes from §6 live here. Panels are pluralised — '1 panels' is
 * the kind of detail that makes a screen feel unmaintained — and an implausible
 * count is left out rather than printed. An 18 kW system with one panel is not a
 * one-panel system; it is a project whose panel count was never filled in
 * properly, and repeating a wrong number to the customer invites a phone call
 * that teaches them the app cannot be trusted. Silence about a field we know is
 * wrong is better than confidence about it.
 */
export function systemLine(input: {
  address: string | null;
  sizeKw: number | null;
  modules: number | null;
  batteries: number | null;
}): string {
  const parts: string[] = [];
  const place = cityState(input.address);
  if (place) parts.push(place);
  if (input.sizeKw) parts.push(`${round1(input.sizeKw)} kW`);
  if (plausiblePanelCount(input.modules, input.sizeKw)) {
    parts.push(`${input.modules} ${input.modules === 1 ? 'panel' : 'panels'}`);
  }
  if (input.batteries) {
    parts.push(`${input.batteries} ${input.batteries === 1 ? 'battery' : 'batteries'}`);
  }
  return parts.join(' · ');
}

/**
 * Does this panel count belong to this system size?
 *
 * Residential modules are roughly 350–550 W, so a plausible count is somewhere
 * near size ÷ 0.45 kW. Anything implying panels above 800 W each is a data-entry
 * artefact, not a very good panel.
 */
export function plausiblePanelCount(modules: number | null, sizeKw: number | null): boolean {
  if (!modules || modules < 1) return false;
  if (!sizeKw) return true; // Nothing to contradict it.
  const wattsEach = (sizeKw * 1000) / modules;
  return wattsEach >= 150 && wattsEach <= 800;
}

const round1 = (n: number): string => String(Math.round(n * 10) / 10);

/** 'Typical 15–30 days', or nothing when the business has set no figure. */
export function typicalLabel(range: TypicalRange | null | undefined): string | null {
  if (!range) return null;
  return range.min === range.max
    ? `Typical ${range.max} days`
    : `Typical ${range.min}–${range.max} days`;
}

/** '7–10 days' for the Up next row. */
export function shortRange(range: TypicalRange | null | undefined): string | null {
  if (!range) return null;
  return range.min === range.max ? `${range.max} days` : `${range.min}–${range.max} days`;
}

/**
 * The next stage, for the one collapsed row under the current card (§2).
 *
 * One row, not six. The other five future stages are on the strip and behind
 * 'Full timeline'; the only future stage anybody asks about is the next one.
 */
export function nextStage(stage: StageKey): StageKey | null {
  const i = stageIndex(stage);
  return i + 1 < STAGES.length ? STAGES[i + 1] : null;
}

export interface TimeInStage {
  day: number;
  /** The ageing threshold this business set for the stage. */
  of: number;
  /** 0–100, capped: past the threshold the bar is full, never overflowing. */
  percent: number;
  /** True once the stage has run past what the business calls normal. */
  over: boolean;
}

/**
 * 'Day 3 of ~10', with a bar.
 *
 * The denominator is the ageing threshold the dashboard already uses — the
 * number this business decided means 'this project needs looking at'. Using the
 * same figure on both sides means the customer's bar fills at the moment the
 * project appears on the PM's attention list, which is the honest relationship
 * between the two screens.
 *
 * Over the threshold the bar stays full rather than growing past its track. A
 * bar that overflows says 'something has gone wrong with the app'; a full bar
 * with 'day 34' next to it says 'this is taking longer than usual', which is the
 * truth and is what the customer already suspects.
 */
export function timeInStage(days: number | null, threshold: number | null): TimeInStage | null {
  if (days === null || days < 0 || !threshold || threshold < 1) return null;
  const day = Math.max(1, days + 1); // The day it entered the stage is day 1.
  return {
    day,
    of: threshold,
    percent: Math.min(100, Math.round((day / threshold) * 100)),
    over: day > threshold,
  };
}

/** 'Your project started 3 days ago' — one quiet line, not an empty card (§6). */
export function startedAgo(days: number | null): string | null {
  if (days === null || days < 0) return null;
  if (days === 0) return 'Your project started today';
  if (days === 1) return 'Your project started yesterday';
  if (days < 31) return `Your project started ${days} days ago`;
  const months = Math.round(days / 30);
  return months === 1 ? 'Your project started a month ago' : `Your project started ${months} months ago`;
}

/**
 * A date a homeowner would read out loud.
 *
 * '2026-09-05' is a database value. On a customer's own screen it reads as a
 * serial number, and the one place it matters most — 'we expect to restart
 * around…' — is exactly where it should sound like a person wrote it.
 *
 * Deliberately not localised: the deployment is one company in one country, and
 * a locale-aware formatter would render differently on the server and in the
 * browser, which React would then report as a hydration mismatch.
 */
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export function prettyDate(iso: string | null): string | null {
  if (!iso) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) return iso;
  const [, year, month, day] = match;
  const name = MONTHS[Number(month) - 1];
  if (!name) return iso;
  const thisYear = new Date().getUTCFullYear();
  const suffix = Number(year) === thisYear ? '' : ` ${year}`;
  return `${Number(day)} ${name}${suffix}`;
}

/** '(210) 555-0199' — a number somebody can read back over the phone. */
export function prettyPhone(raw: string | null): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  if (digits.length === 11 && digits.startsWith('1')) {
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  return raw;
}

/**
 * The stage icons (§5). Named by what they are, not by the library they came
 * from — these are hand-drawn inline SVGs, and the spec's ti-* names are a
 * reference rather than a dependency.
 */
export const STAGE_ICON: Record<StageKey, string> = {
  survey: 'ruler',
  design: 'pencil',
  permits: 'stamp',
  procurement: 'truck',
  install: 'tools',
  inspection_pto: 'plug',
  complete: 'sun',
};
