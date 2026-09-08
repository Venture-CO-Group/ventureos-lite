import { SettingsShell } from "@/components/settings-shell";
import { SettingsExtension } from "@/components/settings-extension";
import { listCaptureTokens } from "@/modules/capture/actions";
import { buildExtensionPackage } from "@/modules/extension/package";

/** Settings → the browser extension and its tokens (P8/3). One per browser, per person. */
export const dynamic = "force-dynamic";

export default async function SettingsExtensionPage() {
  const [tokens, pkg] = await Promise.all([listCaptureTokens(), buildExtensionPackage()]);

  return (
    <SettingsShell
      group="personal"
      pathname="/settings/extension"
      title="browser extension"
      description="The LinkedIn capture extension, and the tokens that let it talk to this workspace."
    >
      <SettingsExtension tokens={tokens} version={pkg.version} />
    </SettingsShell>
  );
}
