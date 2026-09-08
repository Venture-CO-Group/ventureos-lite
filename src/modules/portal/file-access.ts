import { getWorkspaceClient, prismaUnsafe } from "@/lib/db";

/**
 * Which files a read-only client account may fetch (P6/6.3).
 *
 * ── WHY THIS FILE HAD TO EXIST ──────────────────────────────────────────────
 *
 * `/api/files/[...path]` serves anything owned by the caller's active
 * workspace. That was exactly right while every member of a workspace was
 * staff — and it is a leak the moment one of them is a client, because a
 * client is a member: they could fetch another client's contract, or every
 * audit screenshot in the workspace, by path.
 *
 * So a client's read is narrowed twice: it must be a PDF belonging to a
 * FINALIZED document, and that document must hang off their own company. Which
 * is the same rule the portal renders under, asked again at the file boundary
 * rather than trusted from the page that produced the link.
 */
export async function clientMayReadFile(
  workspaceId: string,
  userId: string,
  rel: string,
): Promise<boolean> {
  const membership = await prismaUnsafe.membership.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
    select: { clientCompanyId: true },
  });
  const companyId = membership?.clientCompanyId;
  // No company assigned means no files. The safe direction to be wrong in.
  if (!companyId) return false;

  const db = getWorkspaceClient(workspaceId);
  const doc = await db.document.findFirst({
    where: {
      pdfUrl: rel,
      watermark: false,
      finalizedAt: { not: null },
      // A document has no company of its own — it hangs off a lead or a deal.
      OR: [{ lead: { companyId } }, { deal: { companyId } }],
    },
    select: { id: true },
  });
  return doc !== null;
}
