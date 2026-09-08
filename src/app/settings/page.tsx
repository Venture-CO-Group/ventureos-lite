import Link from "next/link";
import { SettingsShell } from "@/components/settings-shell";
import { SettingsProfile } from "@/components/settings-profile";
import { getMyProfile } from "@/modules/users/profile";
import { isSuperAdmin } from "@/lib/authz";

/**
 * Settings → your profile (P8/3).
 *
 * ── HOW THIS PAGE GOT SMALLER, TWICE ────────────────────────────────────────
 *
 * It was sixteen panels long and mixed four unrelated things: who you are,
 * what reaches you, how the workspace behaves, and how the installation is
 * configured. The last two moved to /settings/admin.
 *
 * That still left one page carrying five unrelated personal concerns in a
 * single scroll — profile, password, notifications, mailbox, extension — and
 * "settings" is the screen people arrive at knowing exactly which one thing
 * they came to change. So each is now its own route behind a menu, and this is
 * the one it opens on: your name, your photo, your timezone.
 */
export const dynamic = "force-dynamic";

export default async function SettingsProfilePage() {
  const [profile, superAdmin] = await Promise.all([getMyProfile(), isSuperAdmin()]);

  return (
    <SettingsShell
      group="personal"
      pathname="/settings"
      title="settings"
      description="Your profile, your sign-in, and what reaches you."
      action={
        superAdmin ? (
          <Link
            href="/settings/admin"
            data-testid="settings-admin-link"
            className="min-h-[40px] rounded-[9px] border border-line bg-panel px-3.5 py-2 text-[12.5px] font-semibold text-ink hover:border-accent"
          >
            Admin settings →
          </Link>
        ) : null
      }
    >
      <SettingsProfile profile={profile} />
    </SettingsShell>
  );
}
