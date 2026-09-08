import { prismaUnsafe } from "./db";

/**
 * Resolve which workspace owns a file path under /data/files (spec §7 / §10).
 * The authenticated file route uses this to serve a file ONLY to a member of
 * its owning workspace — otherwise a user in workspace B could read workspace
 * A's PDFs by guessing paths. Fails CLOSED: unknown paths resolve to null and
 * are treated as not-found.
 */
export async function resolveFileWorkspace(rel: string): Promise<string | null> {
  const slash = rel.indexOf("/");
  if (slash < 0) return null;
  const dir = rel.slice(0, slash);
  const file = rel.slice(slash + 1);

  switch (dir) {
    case "exports": {
      // exports/<workspaceId>-<uuid>.zip
      const wsId = file.split("-")[0];
      const ws = await prismaUnsafe.workspace.findUnique({ where: { id: wsId }, select: { id: true } });
      return ws?.id ?? null;
    }
    case "documents": {
      const doc = await prismaUnsafe.document.findFirst({ where: { pdfUrl: rel }, select: { workspaceId: true } });
      return doc?.workspaceId ?? null;
    }
    case "reports": {
      const r = await prismaUnsafe.report.findFirst({ where: { pdfPath: rel }, select: { workspaceId: true } });
      return r?.workspaceId ?? null;
    }
    case "briefs": {
      const m = await prismaUnsafe.meeting.findFirst({ where: { briefPdfPath: rel }, select: { workspaceId: true } });
      return m?.workspaceId ?? null;
    }
    case "tasks": {
      // tasks/<taskId>-<random>.<ext> — the owner comes from the ATTACHMENT
      // row rather than from the path, so a guessed filename resolves to
      // nothing rather than to whichever task the prefix happens to name.
      const a = await prismaUnsafe.taskAttachment.findFirst({
        where: { path: rel },
        select: { workspaceId: true },
      });
      return a?.workspaceId ?? null;
    }
    case "audits": {
      // audits/<auditId>.pdf | audits/<auditId>-desktop.png | -mobile.png
      const auditId = file.replace(/\.(pdf|png|jpe?g)$/i, "").replace(/-(desktop|mobile)$/i, "");
      const a = await prismaUnsafe.auditResult.findUnique({ where: { id: auditId }, select: { workspaceId: true } });
      return a?.workspaceId ?? null;
    }
    case "avatars": {
      // avatars/<leadId>.<jpg|png|webp> — written by the capture route. Without
      // this case the route fell through to `default` and 404'd every avatar,
      // which is why a captured photo never appeared on a lead.
      const lead = await prismaUnsafe.lead.findFirst({
        where: { avatarPath: rel },
        select: { workspaceId: true },
      });
      return lead?.workspaceId ?? null;
    }
    default:
      return null;
  }
}
