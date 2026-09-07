import { mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { renderHtmlToPdf } from "@/lib/pdf";
import { prismaUnsafe } from "@/lib/db";
import { brandFrom } from "@/modules/workspaces/brand";
import { loadLeadsForExport } from "./bulk-store";
import { buildLeadsPdfHtml, type LeadsPdfMeta } from "./export-formats";

/**
 * Worker side of the branded lead-list PDF.
 *
 * Runs here rather than in a server action for the reason every PDF in this
 * product does: Chromium exists only in the worker image. The app image is
 * node:20-alpine and has no browser.
 *
 * The IDS ride in the payload, not the rendered rows. A lead list can be a
 * thousand rows wide of contact details, and putting that through Redis means
 * personal data sitting in a queue backlog with a different retention story
 * from the database it came from. Re-reading them here costs one query.
 */
const FILES_DIR = process.env.FILES_DIR ?? "/data/files";

export interface LeadsPdfJobData {
  workspaceId: string;
  /** Relative path under FILES_DIR. */
  rel: string;
  ids: string[];
  columns: string[];
  meta: { subtitle: string; exportedAt: string; exportedBy: string };
}

export async function processLeadsPdf(data: LeadsPdfJobData): Promise<void> {
  const { leads, customFields } = await loadLeadsForExport(data.workspaceId, data.ids);

  const ws = await prismaUnsafe.workspace.findUnique({
    where: { id: data.workspaceId },
    select: { brand: true },
  });
  const brand = brandFrom(ws?.brand);

  // Headless Chrome has no session, so a logo behind /api/files would print as
  // a broken box — the same inlining the audit PDF does, for the same reason.
  if (brand.logoUrl && !brand.logoUrl.startsWith("data:")) {
    try {
      const rel = brand.logoUrl.replace(/^\/api\/files\//, "");
      const bytes = await readFile(join(FILES_DIR, rel));
      const ext = rel.split(".").pop()?.toLowerCase();
      const mime =
        ext === "svg"
          ? "image/svg+xml"
          : ext === "jpg" || ext === "jpeg"
            ? "image/jpeg"
            : "image/png";
      brand.logoUrl = `data:${mime};base64,${bytes.toString("base64")}`;
    } catch {
      brand.logoUrl = null; // the wordmark takes over
    }
  }

  const meta: LeadsPdfMeta = {
    subtitle: data.meta.subtitle,
    exportedAt: new Date(data.meta.exportedAt),
    exportedBy: data.meta.exportedBy,
  };
  const html = buildLeadsPdfHtml(leads, data.columns, customFields, brand, meta);
  const pdf = await renderHtmlToPdf(html);

  const abs = join(FILES_DIR, data.rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, pdf);
}
