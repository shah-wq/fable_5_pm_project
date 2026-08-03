import { guardPath } from '@/lib/auth/session';
import { Surface } from '../_components/Surface';

export default async function DesignerHome() {
  await guardPath('/designer');
  return (
    <Surface
      title="Design queue"
      intro="Your assigned projects, availability, and design reviews."
      module="Modules 3–4 (stage forms)"
    />
  );
}
