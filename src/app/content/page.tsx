import { Suspense } from "react";
import { AppShell } from "@/components/app-shell";
import { ContentHubSkeleton } from "@/components/skeletons";
import { ContentHub } from "@/components/content-hub";
import { getContentBoard } from "@/modules/content/actions";

export const dynamic = "force-dynamic";

/**
 * The shell renders as soon as its own (small) query resolves; the board
 * streams in behind a skeleton of the right shape (playbook-v5 P16/2).
 */
export default function ContentPage() {
  return (
    <AppShell activePath="/content">
      <Suspense fallback={<ContentHubSkeleton />}>
        <ContentBody />
      </Suspense>
    </AppShell>
  );
}

async function ContentBody() {
  // Reads only — drafting is a manual button (CLAUDE.md hard rule #3).
  const board = await getContentBoard();
  return <ContentHub board={board} />;
}
