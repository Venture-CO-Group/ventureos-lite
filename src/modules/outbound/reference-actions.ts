"use server";

import { getWorkspaceClient } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { isOwner } from "@/lib/authz";
import { suggestProfile, type ProfileSuggestion } from "./profile-seed";
import { loadSegments } from "./segments";
import { referenceDatasheets } from "./reference-sheets";

/**
 * "Find companies like these" (playbook-v6 F1/4): fetch the datasheets of a
 * product's references and propose a profile. Proposes only — the editor
 * pre-fills, the person edits, nothing is saved here.
 *
 * Owner-only like the profile it feeds, and because each uncached reference
 * spends one unit of the monthly registry quota.
 */
export async function suggestFromReferences(
  productId: string,
): Promise<{ ok: true; suggestion: ProfileSuggestion } | { ok: false; error: string }> {
  if (!(await isOwner())) return { ok: false, error: "Only an Owner can seed a profile from references." };
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const product = await db.product.findUnique({
    where: { id: productId },
    include: { references: { orderBy: { position: "asc" } } },
  });
  if (!product) return { ok: false, error: "That product no longer exists." };
  const refs = product.references.slice(0, 5);
  if (refs.length === 0) return { ok: false, error: "Add one to five reference companies first." };

  const sheets = await referenceDatasheets(workspaceId, refs);
  if (!sheets.ok) return { ok: false, error: sheets.error };
  const segments = await loadSegments(db, workspaceId);
  return {
    ok: true,
    suggestion: suggestProfile(
      sheets.sheets,
      segments.filter((s) => !s.archived),
    ),
  };
}
