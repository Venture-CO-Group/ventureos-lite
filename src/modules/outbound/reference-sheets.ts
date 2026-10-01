import type { CompanyDatasheet } from "@/modules/registry/datasheet";

/**
 * Datasheets for a product's reference companies. Wired to the registry
 * provider in F2; until then it reports that no provider is configured
 * rather than guessing.
 */
export async function referenceDatasheets(
  _workspaceId: string,
  _refs: Array<{ companyName: string; taxNumber: string | null }>,
): Promise<
  { ok: true; sheets: Array<{ name: string; sheet: CompanyDatasheet | null }> } | { ok: false; error: string }
> {
  return { ok: false, error: "No company-registry provider is configured yet." };
}
