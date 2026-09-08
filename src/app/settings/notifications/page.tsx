import { SettingsShell } from "@/components/settings-shell";
import { SettingsNotifications } from "@/components/settings-notifications";
import { getNotificationPreferences } from "@/modules/notifications/preference-actions";

/** Settings → notifications (P8/3). */
export const dynamic = "force-dynamic";

export default async function SettingsNotificationsPage() {
  const initial = await getNotificationPreferences();

  return (
    <SettingsShell
      group="personal"
      pathname="/settings/notifications"
      title="notifications"
      description="What reaches you, and on which channel."
    >
      <SettingsNotifications initial={initial} />
    </SettingsShell>
  );
}
