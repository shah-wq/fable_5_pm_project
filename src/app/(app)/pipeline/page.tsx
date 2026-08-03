import { guardPath } from '@/lib/auth/session';
import { Surface } from '../_components/Surface';

export default async function PipelineHome() {
  await guardPath('/pipeline');
  return (
    <Surface
      title="Pipeline"
      intro="Every project, six stages, one board — the PM's home."
      module="Module 2 (pipeline)"
    />
  );
}
