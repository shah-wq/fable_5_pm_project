/**
 * The seven pipeline stages, in order (Complete is the terminal column).
 * Must stay in sync with the public.project_stage enum
 * (db/migrations/…001200 + …001500).
 */

export const STAGES = [
  'survey',
  'design',
  'permits',
  'procurement',
  'install',
  'inspection_pto',
  'complete',
] as const;

export type StageKey = (typeof STAGES)[number];

export const STAGE_LABELS: Record<StageKey, string> = {
  survey: 'Survey',
  design: 'Design',
  permits: 'Permits',
  procurement: 'Procurement',
  install: 'Install',
  inspection_pto: 'Inspection & PTO',
  complete: 'Complete',
};

/** The green button's label on each stage form (Complete is terminal). */
export const ADVANCE_LABELS: Record<StageKey, string> = {
  survey: 'Move to Design',
  design: 'Move to Permits',
  permits: 'Move to Procurement',
  procurement: 'Move to Installation',
  install: 'Move to Inspection & PTO',
  inspection_pto: 'Move to Complete',
  complete: '',
};

export function isStageKey(value: string): value is StageKey {
  return (STAGES as readonly string[]).includes(value);
}

export function stageIndex(stage: StageKey): number {
  return STAGES.indexOf(stage);
}

/** The stage after `stage`, or null on the last stage (completion instead). */
export function nextStage(stage: StageKey): StageKey | null {
  const i = stageIndex(stage);
  return i < STAGES.length - 1 ? STAGES[i + 1] : null;
}

/** The stage before `stage`, or null on the first. */
export function prevStage(stage: StageKey): StageKey | null {
  const i = stageIndex(stage);
  return i > 0 ? STAGES[i - 1] : null;
}

/** Document/photo slot categories the requirements engine checks. */
export const DOC_CATEGORIES = {
  surveyPhotos: [
    'photo_roof',
    'photo_attic',
    'photo_main_panel',
    'photo_meter',
    'photo_wire_path',
    'photo_obstructions',
  ],
  planSetDwg: 'plan_set_dwg',
  planSetPdf: 'plan_set_pdf',
  stampedSet: 'stamped_set',
  signedCo: 'signed_co',
  permitLetter: (track: string) => `permit_letter_${track}`,
  signatureDocs: 'signature_docs',
  deliveryPhotos: 'photo_delivery',
  workOrder: 'work_order',
  completionPhotos: 'photo_completion',
  inspectionSignoff: 'inspection_signoff',
  ptoLetter: 'pto_letter',
} as const;
