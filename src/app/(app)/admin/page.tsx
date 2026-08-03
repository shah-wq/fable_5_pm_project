import { guardPath } from '@/lib/auth/session';
import { Surface } from '../_components/Surface';

export default async function AdminHome() {
  await guardPath('/admin');
  return (
    <Surface
      title="Admin"
      intro="Company settings, users & invitations, rules, and the audit trail."
      module="Module 6 (admin panel)"
    />
  );
}
