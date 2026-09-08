import { SettingsShell } from "@/components/settings-shell";
import { WorkspaceList } from "@/components/workspace-list";
import { WorkspaceAdmin } from "@/components/workspace-admin";
import { copyableWorkspaces, listWorkspaces } from "@/modules/workspaces/actions";
import { isOwner } from "@/lib/authz";

/**
 * Settings — WORKSPACES.
 *
 * ── WHY THIS PAGE EXISTS ────────────────────────────────────────────────────
 *
 * The "New workspace" form lived inside `/settings/admin`, which is gated to
 * the SUPER ADMIN — the person who administers the installation, not the person
 * who owns a workspace. `/settings/admin` also `notFound()`s rather than
 * refusing, so to anyone but the operator the form did not merely fail to open:
 * it did not appear to exist. The admin page's own comment flagged this and
 * predicted the fix; a second workspace made it due.
 *
 * So workspace management is its own Owner-gated page, reachable from the
 * switcher in the sidebar — which is where somebody looks when they want
 * another workspace, and where nothing previously said one could be made.
 *
 * The gate is `isOwner()` and it is deliberately weaker than the admin page's:
 * an Owner must be able to reach their own workspaces. Every mutation behind
 * this page re-checks Owner-ship OF THE WORKSPACE IT TOUCHES, because a page
 * check protects a page and the only thing that protects a mutation is the
 * mutation.
 */
export const dynamic = "force-dynamic";

export default async function WorkspaceSettingsPage() {
  const [workspaces, owner] = await Promise.all([listWorkspaces(), isOwner()]);
  // Owner memberships only, so the form cannot offer a source the action would
  // refuse (P6/6.1).
  const copySources = owner ? await copyableWorkspaces() : [];

  return (
    <SettingsShell
      group="admin"
      pathname="/settings/workspaces"
      title="workspaces"
      description={`${workspaces.length} ${
        workspaces.length === 1 ? "workspace" : "workspaces"
      } · provision one, copy settings into it, or repair one.`}
    >
      <WorkspaceList workspaces={workspaces} />
      <WorkspaceAdmin isOwner={owner} copyableWorkspaces={copySources} />
    </SettingsShell>
  );
}
