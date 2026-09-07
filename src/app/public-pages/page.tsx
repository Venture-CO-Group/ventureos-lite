import { AppShell } from "@/components/app-shell";
import { PublicPages } from "@/components/public-pages";
import { getPublicPages } from "@/modules/public-pages/actions";
import { hasGrant } from "@/lib/authz";

export const dynamic = "force-dynamic";

export default async function PublicPagesScreen() {
  // The capability, not the role: publishing and withdrawing a prospect-facing
  // page is daily sales work, and a BDR carries it unless an Owner takes it
  // away.
  const [data, canManage] = await Promise.all([
    getPublicPages(),
    hasGrant("public_pages.manage"),
  ]);
  return (
    <AppShell activePath="/public-pages">
      <PublicPages data={data} isOwner={canManage} />
    </AppShell>
  );
}
