import { guardPath } from '@/lib/auth/session';
import { Surface } from '../_components/Surface';

export default async function PortalHome() {
  await guardPath('/portal');
  return (
    <Surface
      title="Your solar project"
      intro="Where your installation stands, your documents, and what happens next."
      module="Module 7 (customer portal)"
    />
  );
}
