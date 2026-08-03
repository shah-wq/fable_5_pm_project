import Link from 'next/link';
import { STAGES, STAGE_LABELS, stageIndex, type StageKey } from '@/lib/stages/definitions';

/**
 * The stage stepper: completed stages green (open read-only), the current
 * stage highlighted (opens its form), future stages visible but locked.
 */
export function Stepper({
  projectId,
  current,
  completed,
}: {
  projectId: string;
  current: StageKey;
  completed: boolean;
}) {
  const currentIndex = stageIndex(current);
  return (
    <ol className="stepper">
      {STAGES.map((stage, i) => {
        const state = completed
          ? 'done'
          : i < currentIndex
            ? 'done'
            : i === currentIndex
              ? 'current'
              : 'locked';
        const label = (
          <>
            <span className="step-num">{i + 1}</span>
            <span>{STAGE_LABELS[stage]}</span>
          </>
        );
        return (
          <li key={stage} className={`step ${state}`}>
            {state === 'locked' ? (
              <span title="Locked until reached">{label}</span>
            ) : (
              <Link href={`/projects/${projectId}/stages/${stage}`}>{label}</Link>
            )}
          </li>
        );
      })}
    </ol>
  );
}
