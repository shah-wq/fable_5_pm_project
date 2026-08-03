import { guardPath } from '@/lib/auth/session';
import { Surface } from '../../_components/Surface';

export default async function FinanceHome() {
  await guardPath('/admin/finance');
  return (
    <Surface
      title="Finance"
      intro="Contract values, invoicing and payments across every project — the whitelisted view."
      module="Module 6 (admin panel, finance area)"
    />
  );
}
