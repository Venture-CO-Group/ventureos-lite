import { SettingsShell } from "@/components/settings-shell";
import { SecurityPanel } from "@/components/security-panel";
import { getSecurityStatus } from "@/modules/auth/actions";

/**
 * Settings → sign-in & security (P8/3).
 *
 * `?security=password` still lands here and focuses the password field: the
 * "you must change your password" redirect and the reset flow both link to it,
 * and moving the panel to its own route must not break a link somebody
 * receives by email.
 */
export const dynamic = "force-dynamic";

export default async function SettingsSecurityPage({
  searchParams,
}: {
  searchParams: Promise<{ security?: string }>;
}) {
  const [{ security }, status] = await Promise.all([searchParams, getSecurityStatus()]);

  return (
    <SettingsShell
      group="personal"
      pathname="/settings/security"
      title="sign-in & security"
      description="Your password, your second factor, and every device signed in as you."
    >
      <SecurityPanel status={status} focusPassword={security === "password"} />
    </SettingsShell>
  );
}
