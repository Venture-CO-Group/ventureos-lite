import { SettingsShell } from "@/components/settings-shell";
import { SettingsEmail } from "@/components/settings-email";

/**
 * Settings → email (P8/3).
 *
 * The mailbox is YOURS, which is why it is under personal settings and not
 * admin. It sat on /settings/admin after the first settings split — fine on a
 * one-person installation, and it would have meant a second user could never
 * connect their own mail, because that page 404s for anybody but the super
 * admin.
 */
export const dynamic = "force-dynamic";

export default function SettingsEmailPage() {
  return (
    <SettingsShell
      group="personal"
      pathname="/settings/email"
      title="email"
      description="Connect your own mailbox so replies land in the Inbox."
    >
      <SettingsEmail />
    </SettingsShell>
  );
}
