import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { FinderEditor } from "@/components/finder-editor";
import { getWorkspaceClient } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { hasGrant } from "@/lib/authz";
import { DEFAULT_CRITERIA } from "@/modules/finder/criteria";
import { loadSegments } from "@/modules/outbound/segments";

export const dynamic = "force-dynamic";

export default async function NewFinderListPage() {
  const { workspaceId } = await getActiveContext();
  if (!(await hasGrant("settings.manage"))) redirect("/finder");
  const segments = (await loadSegments(getWorkspaceClient(workspaceId), workspaceId)).filter((s) => !s.archived);
  return (
    <AppShell activePath="/finder">
      <h2 className="mb-4 font-display text-[22px] font-extrabold lowercase tracking-display">new list</h2>
      <FinderEditor
        initialName=""
        initial={DEFAULT_CRITERIA}
        segments={segments.map((s) => ({ key: s.key, name: s.name, fragments: s.fragments.length }))}
        canEdit
      />
    </AppShell>
  );
}
