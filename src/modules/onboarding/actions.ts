"use server";

import { revalidatePath } from "next/cache";
import { getWorkspaceClient, prismaUnsafe } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import {
  CHECKLIST,
  checklistComplete,
  type ChecklistState,
} from "./tour";

/**
 * Onboarding state (playbook-v2 P7/4).
 *
 * The checklist is COMPUTED from what is actually in the workspace, never
 * stored as ticks. A stored tick drifts: someone deletes their only lead and
 * the checklist still says they have one, which is worse than no checklist. The
 * cost is four counts on the dashboard, which is nothing beside being wrong.
 */

export interface OnboardingView {
  /** True when this person has never finished or dismissed the tour. */
  showTour: boolean;
  showChecklist: boolean;
  checklist: ChecklistState;
  progress: { done: number; total: number };
}

export async function getOnboarding(): Promise<OnboardingView> {
  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  const [user, mailAccounts, leads, audits, meetings, posts, tokens] = await Promise.all([
    prismaUnsafe.user.findUnique({
      where: { id: userId },
      select: { tourSeenAt: true, checklistHiddenAt: true },
    }),
    db.mailAccount.count({ where: { userId } }),
    db.lead.count({ where: { mergedIntoId: null } }),
    db.auditResult.count(),
    db.meeting.count(),
    db.contentPost.count(),
    /**
     * "Installed the extension" is not directly observable, so the closest
     * honest proxy is used: a capture token exists. A token is issued in order
     * to pair the extension, and nothing else issues one — so it means
     * somebody got as far as setting it up, which is what the step is for.
     */
    db.captureToken.count(),
  ]);

  const checklist: ChecklistState = {
    install_extension: tokens > 0,
    connect_email: mailAccounts > 0,
    first_lead: leads > 0,
    first_audit: audits > 0,
    first_meeting: meetings > 0,
    first_post: posts > 0,
  };

  return {
    showTour: !user?.tourSeenAt,
    // Hidden once every item is done, or once dismissed by hand. A checklist
    // that stays after it is finished is a to-do list that lies.
    showChecklist: !user?.checklistHiddenAt && !checklistComplete(checklist),
    checklist,
    progress: {
      done: CHECKLIST.filter((i) => checklist[i.id]).length,
      total: CHECKLIST.length,
    },
  };
}

/** Mark the tour done. Called on finish AND on dismiss — both mean "not again". */
export async function completeTour(): Promise<{ ok: true }> {
  const { userId } = await getActiveContext();
  await prismaUnsafe.user.update({
    where: { id: userId },
    data: { tourSeenAt: new Date() },
  });
  revalidatePath("/");
  return { ok: true };
}

export async function hideChecklist(): Promise<{ ok: true }> {
  const { userId } = await getActiveContext();
  await prismaUnsafe.user.update({
    where: { id: userId },
    data: { checklistHiddenAt: new Date() },
  });
  revalidatePath("/");
  return { ok: true };
}

