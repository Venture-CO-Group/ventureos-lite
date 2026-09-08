import { SettingsShell } from "@/components/settings-shell";
import { SettingsUsers } from "@/components/settings-users";
import { SettingsInvitations } from "@/components/settings-invitations";
import { SettingsGrants } from "@/components/settings-grants";
import { SettingsTeams } from "@/components/settings-teams";
import { SettingsPermissions } from "@/components/settings-permissions";
import { requireSuperAdminPage } from "../gate";
import { listWorkspaceUsers, listClientCompanies } from "@/modules/users/actions";
import { listMembers } from "@/modules/settings/actions";
import { getInvitations } from "@/modules/members/actions";
import { getTeams } from "@/modules/teams/actions";
import { getSecurityStatus } from "@/modules/auth/actions";
import { isOwner } from "@/lib/authz";

/**
 * Admin → members & teams (P8/3).
 *
 * The page the owner asked for by name: one route where the only thing you can
 * do is manage the people in this workspace. Everything about a member —
 * inviting them, their role, their capabilities, standing them down, removing
 * them — is here and nowhere else.
 */
export const dynamic = "force-dynamic";

export default async function AdminMembersPage() {
  await requireSuperAdminPage();
  const owner = await isOwner();

  const [members, securityStatus] = await Promise.all([listMembers(), getSecurityStatus()]);
  // Owner-only; `listWorkspaceUsers` throws for anyone else, so only ask when
  // we already know the answer.
  const managedUsers = owner ? await listWorkspaceUsers() : [];
  // Only companies with something to show — a client account pointed at a
  // company with no project and no finalized document logs in to an empty
  // page, which reads as a broken feature (P6/6.3).
  const clientCompanies = owner ? await listClientCompanies() : [];
  const invitations = owner ? await getInvitations() : [];
  const teams = owner ? await getTeams() : [];

  return (
    <SettingsShell
      group="admin"
      pathname="/settings/admin/members"
      title="members &amp; teams"
      description="Who is in this workspace, what they may do, and how they leave."
    >
      {owner && (
        <SettingsInvitations invitations={invitations} clientCompanies={clientCompanies} />
      )}
      {owner ? (
        <SettingsUsers
          users={managedUsers}
          minPasswordLength={securityStatus.minPasswordLength}
          clientCompanies={clientCompanies}
        />
      ) : (
        <div className="rounded-card border border-line bg-panel p-[18px]">
          <p className="text-[12.5px] text-muted">
            Only an Owner can manage members.
          </p>
        </div>
      )}
      {owner && (
        <SettingsTeams
          teams={teams}
          /* Active staff only: a team is a work grouping, and neither a
             pending invitation nor a client account does work here. */
          members={managedUsers
            .filter((u) => u.state === "ACTIVE" && u.role !== "CLIENT")
            .map((u) => ({ id: u.userId, name: u.name, email: u.email }))}
        />
      )}
      <SettingsPermissions />
      <SettingsGrants members={members} isOwner={owner} />
    </SettingsShell>
  );
}
