import type { CompanyDatasheet } from "@/modules/registry/datasheet";
import { getDatasheet, searchRegistry } from "@/modules/registry/registry-service";
import { cegadatTaxId } from "@/modules/registry/cegadat";

/**
 * Datasheets for a product's reference companies (playbook-v6 F1/4).
 *
 * A reference with a tax number is looked up directly; one with only a name
 * is resolved through the free search first, taking the best match. Each
 * uncached lookup is charged as REFERENCE_SEED, an interactive purpose: an
 * Owner is waiting for the answer, so it may draw on the reserve.
 */
export async function referenceDatasheets(
  workspaceId: string,
  refs: Array<{ companyName: string; taxNumber: string | null }>,
  userId?: string,
): Promise<
  { ok: true; sheets: Array<{ name: string; sheet: CompanyDatasheet | null }> } | { ok: false; error: string }
> {
  const out: Array<{ name: string; sheet: CompanyDatasheet | null }> = [];
  for (const ref of refs) {
    let tax = ref.taxNumber ? cegadatTaxId(ref.taxNumber) : null;
    if (!tax && ref.companyName.trim().length >= 4) {
      const found = await searchRegistry(workspaceId, { name: ref.companyName, limit: 1, businessType: "all" });
      if (!found.ok && found.reason === "unavailable") return { ok: false, error: found.message };
      tax = found.ok && found.page.hits[0] ? cegadatTaxId(found.page.hits[0].taxNumber) : null;
    }
    if (!tax) {
      out.push({ name: ref.companyName, sheet: null });
      continue;
    }
    const res = await getDatasheet(workspaceId, tax, { purpose: "REFERENCE_SEED", userId });
    if (res.status === "unavailable") return { ok: false, error: res.message };
    if (res.status === "quota_exhausted") {
      return { ok: false, error: "The registry lookup quota for this month is used up." };
    }
    out.push({ name: ref.companyName, sheet: res.status === "ok" ? res.sheet : null });
  }
  return { ok: true, sheets: out };
}
