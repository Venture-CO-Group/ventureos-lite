"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { attempt } from "@/lib/client/server-action";
import { deleteFinderList } from "@/modules/finder/actions";

/** Delete a saved list. Permanent (see src/modules/undo/contract.ts), so it asks first. */
export function FinderDelete({ listId }: { listId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      className="min-h-[44px] text-[12px] text-muted underline hover:text-ink disabled:opacity-45 sm:min-h-0"
      disabled={pending}
      onClick={() => {
        if (
          !confirm(
            "Delete this list with its results and run history? The companies stay in the shared pool and the datasheet cache.",
          )
        )
          return;
        startTransition(async () => {
          const res = await attempt(deleteFinderList(listId));
          if (!res.ok) alert(res.error);
          else router.push("/finder");
        });
      }}
    >
      Delete list
    </button>
  );
}
