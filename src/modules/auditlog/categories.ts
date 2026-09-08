/**
 * Audit-log groupings (CLAUDE.md hard rule #8).
 *
 * A plain module, not the "use server" one beside it: a file marked
 * `"use server"` may only export async functions, and a const array exported
 * from one fails the production build with "can only export async functions,
 * found object". The same trap the profile limits fell into.
 */
export const AUDIT_LOG_CATEGORIES = [
  { id: "all", label: "Minden", prefixes: [] as string[] },
  {
    id: "access",
    label: "Hozzáférés és jogosultság",
    prefixes: ["grant.", "member.", "user.", "auth."],
  },
  {
    id: "data",
    label: "Adat: export, törlés, egyesítés",
    prefixes: [
      "export.",
      "lead.deleted",
      "lead.erasure",
      "data.",
      "import.",
      "retention.",
      // Reading and pruning the log are themselves data events, and the row
      // that explains a gap in the log has to be findable (P5/5.3).
      "audit_log.",
      // A webhook is a standing instruction to send this workspace's data
      // somewhere else — an export with no end date (P5/5.2).
      "webhook.",
    ],
  },
  {
    id: "documents",
    label: "Dokumentumok és számlázás",
    prefixes: ["document.", "invoice.", "szamlazz.", "public."],
  },
  {
    id: "config",
    label: "Beállítások",
    prefixes: [
      "fields.",
      "workflow.",
      "workspace.",
      "deals.",
      "cold_email.",
      "calendar.",
      "capture.",
      "proposal.",
    ],
  },
] as const;

export type AuditCategoryId = (typeof AUDIT_LOG_CATEGORIES)[number]["id"];
