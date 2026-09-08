import { guardRoute } from "@/lib/rate-limit-guard";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tryGetActiveContextOrThrow } from "@/lib/session";
import { resolveFileWorkspace } from "@/lib/file-owner";
import { isClientRole } from "@/lib/grants";
import { clientMayReadFile } from "@/modules/portal/file-access";

/**
 * Authenticated file serving for the /data/files volume (CLAUDE.md: files
 * served through authenticated routes). Screenshots + audit PDFs for internal
 * users. Public share pages are served separately by slug, not through here.
 */
const FILES_DIR = process.env.FILES_DIR ?? "/data/files";

const CONTENT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  // Accepted by the avatar downloader, so it has to be servable too.
  webp: "image/webp",
  zip: "application/zip",
  csv: "text/csv",
};

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  // The API-wide backstop (P6/2). Authenticated, so this is not an abuse
  // control so much as a guard against a runaway client asking for the same
  // PDF a thousand times a second.
  const limited = await guardRoute("api");
  if (limited) return limited;

  let workspaceId: string;
  let userId: string;
  let role: string;
  try {
    ({ workspaceId, userId, role } = await tryGetActiveContextOrThrow());
  } catch {
    return new Response("Unauthorized", { status: 401 });
  }

  const { path } = await params;
  const rel = path.join("/");
  if (rel.includes("..")) return new Response("Bad path", { status: 400 });

  // Tenancy: serve only files owned by the caller's active workspace. Fail closed
  // (404) on unknown paths or cross-workspace requests — never leak existence.
  const owner = await resolveFileWorkspace(rel);
  if (owner === null || owner !== workspaceId) {
    return new Response("Not found", { status: 404 });
  }

  /**
   * A client is a member, and workspace ownership alone is not enough for them
   * (P6/6.3).
   *
   * Without this, a read-only client account could fetch another client's
   * contract, or every audit screenshot in the workspace, by path — the check
   * above would happily agree that all of it belongs to their workspace.
   */
  if (isClientRole(role) && !(await clientMayReadFile(workspaceId, userId, rel))) {
    return new Response("Not found", { status: 404 });
  }

  try {
    const buf = await readFile(join(FILES_DIR, rel));
    const ext = rel.split(".").pop()?.toLowerCase() ?? "";
    /**
     * Task attachments are DOWNLOADED, never rendered in place.
     *
     * Everything else under this route is something we produced — an audit
     * screenshot, a generated PDF — and previewing it inline is the point. A
     * task attachment is a file a person uploaded, served back from our own
     * origin, so rendering it inline would let an uploaded document execute
     * with our domain behind it. `attachment` makes the browser save it.
     */
    const isUpload = rel.startsWith("tasks/");
    return new Response(new Uint8Array(buf), {
      headers: {
        "Content-Type": CONTENT_TYPES[ext] ?? "application/octet-stream",
        "Cache-Control": "private, max-age=60",
        ...(isUpload
          ? {
              "Content-Disposition": `attachment; filename="${rel
                .split("/")
                .pop()
                ?.replace(/[^A-Za-z0-9._-]/g, "_")}"`,
            }
          : {}),
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
