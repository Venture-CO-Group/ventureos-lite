/**
 * Names from a Hungarian site's impresszum (playbook-v6 F3/7). Shared by the
 * site reader and the outbound contact waterfall.
 */

/**
 * The "represented by" line of an impresszum: "Képviseli: Kovács Anna
 * ügyvezető", "Ügyvezető: Dr. Nagy Péter". Names only — two to four
 * capitalised words — so a sentence that happens to follow the colon is not
 * mistaken for a person.
 */
export function extractRepresentedBy(text: string): string[] {
  const out: string[] = [];
  const re = /(képviseli|képviselő|képviseletre jogosult|ügyvezető|ügyvezetője|cégvezető|tulajdonos)\s*:\s*((?:dr\.\s*)?[A-ZÁÉÍÓÖŐÚÜŰ][a-záéíóöőúüű.-]+(?:\s+[A-ZÁÉÍÓÖŐÚÜŰ][a-záéíóöőúüű.-]+){1,3})/gi;
  for (const m of text.matchAll(re)) {
    const name = m[2]!.replace(/\s+(ügyvezető|igazgató|tulajdonos).*$/i, "").trim();
    if (name && !out.includes(name)) out.push(name);
  }
  return out.slice(0, 3);
}
