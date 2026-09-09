import { Suspense } from "react";
import { AppShell } from "@/components/app-shell";
import { InboxSkeleton } from "@/components/skeletons";
import { Inbox } from "@/components/inbox";
import { listThreads } from "@/modules/inbox/actions";
import { getWorkspaceClient } from "@/lib/db";
import { getActiveContext } from "@/lib/session";

export const dynamic = "force-dynamic";

export default function InboxPage() {
  return (
    <AppShell activePath="/inbox">
      <Suspense fallback={<InboxSkeleton />}>
        <InboxBody />
      </Suspense>
    </AppShell>
  );
}

async function InboxBody() {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const [threads, leadRows] = await Promise.all([
    listThreads(),
    db.lead.findMany({
      orderBy: { createdAt: "desc" },
      take: 200,
      select: { id: true, contactName: true, company: { select: { name: true } } },
    }),
  ]);
  const leads = leadRows.map((l) => ({
    id: l.id,
    name: l.contactName ?? l.company?.name ?? "Unnamed lead",
  }));

  return <Inbox threads={threads} leads={leads} />;
}
