import { guardPath } from '../auth/session';
import { withUser } from '../db';
import { loadCustomerProject, loadCustomerProjects, type CustomerProject } from './customer';

/**
 * What every tab of the customer app needs: the signed-in customer, which of
 * their properties is being shown, and that project's customer-safe view.
 *
 * One loader for all five tabs, so the tabs cannot drift apart in what they
 * consider visible — the scoping decision is made once.
 */
export async function loadPortalPage(
  searchParams: Promise<{ project?: string }>
): Promise<{
  projects: Array<{ id: string; label: string }>;
  project: CustomerProject | null;
}> {
  const session = await guardPath('/portal');
  const sp = await searchParams;

  return withUser(session, async (client) => {
    const projects = await loadCustomerProjects(client, session);
    const chosen =
      sp.project && projects.some((p) => p.id === sp.project)
        ? sp.project
        : (projects[0]?.id ?? null);
    const project = chosen ? await loadCustomerProject(client, chosen) : null;
    return { projects, project };
  });
}

/**
 * The holding screen for a customer whose project has not been created yet
 * (spec §2). A friendly screen with a way to reach a human beats an error.
 */
export const NO_PROJECT_MESSAGE =
  'Your project is being set up. Your project manager will be in touch as soon as it is ready — and everything will appear here.';
