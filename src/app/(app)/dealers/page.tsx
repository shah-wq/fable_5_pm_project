import { guardPath } from '@/lib/auth/session';
import { Surface } from '../_components/Surface';

export default async function DealerHome() {
  await guardPath('/dealers');
  return (
    <Surface
      title="Your book"
      intro="Every project you've sold, its stage, and anything waiting on you."
      module="Module 7 (dealer portal)"
    />
  );
}
