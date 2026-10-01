/**
 * Products, profiles and segments — the input shapes and their parsers
 * (playbook-v6 F1). A plain module, so the server actions beside it can stay
 * `"use server"` (which may only export async functions) and the tests can
 * import the schemas without a session.
 */
import { z } from "zod";
import type {
  CampaignMode,
  ContactRequirement,
  IcpProfile,
  Product,
  ProductReference,
  Segment,
  SourcingHint,
} from "@prisma/client";
import { SIZE_BANDS, parseSizeBands, type SizeBand } from "./size-band";
import type { SeedEntry } from "./segments-seed";

const trimmed = (max: number) => z.string().trim().max(max);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));

export function slugify(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export const valuePropSchema = z.object({
  claim: trimmed(300).min(1),
  // A value prop without evidence is a slogan; the draft prompt is told to
  // make ONE evidenced claim, so the evidence is required here.
  evidence: trimmed(500).min(1),
});

export const assetSchema = z.object({
  label: trimmed(120).min(1),
  url: z.string().trim().url().max(1000),
});

export const referenceInputSchema = z.object({
  companyName: trimmed(200).min(1),
  taxNumber: optionalText(20),
  isClient: z.boolean(),
  note: optionalText(500),
});

export const productInputSchema = z.object({
  id: z.string().min(1).optional(),
  name: trimmed(120).min(1),
  slug: z
    .string()
    .trim()
    .max(60)
    .regex(/^[a-z0-9-]*$/, "Lowercase letters, digits and dashes only.")
    .optional(),
  category: z.enum(["OWN_SERVICE", "PARTNER_SOLUTION"]),
  partner: optionalText(200),
  problemSolved: trimmed(1000).min(1),
  valueProps: z.array(valuePropSchema).max(8),
  proofPoints: z.array(trimmed(300).min(1)).max(10),
  priceBand: optionalText(120),
  assets: z.array(assetSchema).max(10),
  status: z.enum(["ACTIVE", "PAUSED", "RETIRED"]),
  language: z.enum(["HU", "EN"]),
  priority: z.number().int().min(0).max(100),
  references: z.array(referenceInputSchema).max(20),
});
export type ProductInput = z.infer<typeof productInputSchema>;

const forints = z
  .number()
  .int()
  .min(0)
  .max(10_000_000_000_000)
  .nullish()
  .transform((v) => (v === null || v === undefined ? null : v));
const year = z.number().int().min(1850).max(2100).nullish().transform((v) => v ?? null);
const score = z.number().int().min(0).max(100).nullish().transform((v) => v ?? null);
const stringList = (max: number) => z.array(trimmed(120).min(1)).max(max);

export const profileInputSchema = z
  .object({
    id: z.string().min(1).optional(),
    productId: z.string().min(1),
    name: trimmed(120).min(1),
    segmentKeys: stringList(19),
    sizeBands: z.array(z.enum(SIZE_BANDS)).max(4),
    includeUnknownSize: z.boolean(),
    revenueMin: forints,
    revenueMax: forints,
    counties: stringList(20),
    cities: stringList(50),
    legalForms: stringList(10),
    foundedAfter: year,
    foundedBefore: year,
    statusRequired: trimmed(40).min(1),
    requiresWebsite: z.boolean(),
    auditScoreMin: score,
    auditScoreMax: score,
    requiredSignals: stringList(10),
    contactRequirement: z.enum(["NAMED_CONTACT", "GENERIC_OK"]),
    excludeExistingClients: z.boolean(),
    mode: z.enum(["VOLUME", "ACCOUNT"]),
    dailyQuota: z.number().int().min(0).max(100),
    weight: z.number().int().min(1).max(10),
    active: z.boolean(),
  })
  .refine((p) => p.revenueMin === null || p.revenueMax === null || p.revenueMin <= p.revenueMax, {
    message: "Minimum revenue is above the maximum.",
    path: ["revenueMin"],
  })
  .refine((p) => p.auditScoreMin === null || p.auditScoreMax === null || p.auditScoreMin <= p.auditScoreMax, {
    message: "Minimum audit score is above the maximum.",
    path: ["auditScoreMin"],
  })
  .refine((p) => p.segmentKeys.length > 0 || p.sizeBands.length > 0, {
    // Each layer is enough on its own (spec §4.43.2) — but a profile with
    // none of them targets every company in the country.
    message: "Pick at least one segment or one size band.",
    path: ["segmentKeys"],
  });
export type ProfileInput = z.infer<typeof profileInputSchema>;

export const seedEntrySchema = z
  .object({ name: optionalText(200), taxNumber: optionalText(20) })
  .refine((e) => e.name || e.taxNumber, { message: "A seed needs a name or a tax number." });

export const segmentInputSchema = z.object({
  id: z.string().min(1),
  name: trimmed(120).min(1),
  teaorInclude: z.array(z.string().trim().regex(/^[0-9.]{2,7}$/, "TEÁOR codes are digits.")).max(40),
  teaorExclude: z.array(z.string().trim().regex(/^[0-9.]{2,7}$/, "TEÁOR codes are digits.")).max(40),
  fragments: z.array(trimmed(60).min(2)).max(40),
  seedList: z.array(seedEntrySchema).max(300),
  sourcingHint: z.enum(["NAME_HARVEST_STRONG", "NAME_HARVEST_WEAK", "SEED_LIST", "PLACES"]),
  archived: z.boolean(),
});
export type SegmentInput = z.infer<typeof segmentInputSchema>;

// ---- views -----------------------------------------------------------------

export interface ValueProp {
  claim: string;
  evidence: string;
}
export interface ProductAsset {
  label: string;
  url: string;
}

function jsonArray(raw: unknown): unknown[] {
  return Array.isArray(raw) ? raw : [];
}
export function stringArray(raw: unknown): string[] {
  return jsonArray(raw).filter((v): v is string => typeof v === "string");
}

export interface ProductView {
  id: string;
  name: string;
  slug: string;
  category: Product["category"];
  partner: string | null;
  problemSolved: string;
  valueProps: ValueProp[];
  proofPoints: string[];
  priceBand: string | null;
  assets: ProductAsset[];
  status: Product["status"];
  language: Product["language"];
  priority: number;
  references: Array<Pick<ProductReference, "id" | "companyName" | "taxNumber" | "isClient" | "note">>;
  profiles: ProfileView[];
}

export function toProductView(
  p: Product & { references: ProductReference[]; profiles: IcpProfile[] },
): ProductView {
  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    category: p.category,
    partner: p.partner,
    problemSolved: p.problemSolved,
    valueProps: jsonArray(p.valueProps).filter(
      (v): v is ValueProp =>
        !!v && typeof (v as ValueProp).claim === "string" && typeof (v as ValueProp).evidence === "string",
    ),
    proofPoints: stringArray(p.proofPoints),
    priceBand: p.priceBand,
    assets: jsonArray(p.assets).filter(
      (v): v is ProductAsset =>
        !!v && typeof (v as ProductAsset).label === "string" && typeof (v as ProductAsset).url === "string",
    ),
    status: p.status,
    language: p.language,
    priority: p.priority,
    references: [...p.references]
      .sort((a, b) => a.position - b.position)
      .map((r) => ({
        id: r.id,
        companyName: r.companyName,
        taxNumber: r.taxNumber,
        isClient: r.isClient,
        note: r.note,
      })),
    profiles: p.profiles.map(toProfileView),
  };
}

export interface ProfileView {
  id: string;
  productId: string;
  name: string;
  segmentKeys: string[];
  sizeBands: SizeBand[];
  includeUnknownSize: boolean;
  /** Forints, as a number — safe up to 9 × 10^15, far beyond any revenue filter. */
  revenueMin: number | null;
  revenueMax: number | null;
  counties: string[];
  cities: string[];
  legalForms: string[];
  foundedAfter: number | null;
  foundedBefore: number | null;
  statusRequired: string;
  requiresWebsite: boolean;
  auditScoreMin: number | null;
  auditScoreMax: number | null;
  requiredSignals: string[];
  contactRequirement: ContactRequirement;
  excludeExistingClients: boolean;
  mode: CampaignMode;
  dailyQuota: number;
  weight: number;
  active: boolean;
}

export function toProfileView(p: IcpProfile): ProfileView {
  return {
    id: p.id,
    productId: p.productId,
    name: p.name,
    segmentKeys: stringArray(p.segmentKeys),
    sizeBands: parseSizeBands(p.sizeBands),
    includeUnknownSize: p.includeUnknownSize,
    revenueMin: p.revenueMin === null ? null : Number(p.revenueMin),
    revenueMax: p.revenueMax === null ? null : Number(p.revenueMax),
    counties: stringArray(p.counties),
    cities: stringArray(p.cities),
    legalForms: stringArray(p.legalForms),
    foundedAfter: p.foundedAfter,
    foundedBefore: p.foundedBefore,
    statusRequired: p.statusRequired,
    requiresWebsite: p.requiresWebsite,
    auditScoreMin: p.auditScoreMin,
    auditScoreMax: p.auditScoreMax,
    requiredSignals: stringArray(p.requiredSignals),
    contactRequirement: p.contactRequirement,
    excludeExistingClients: p.excludeExistingClients,
    mode: p.mode,
    dailyQuota: p.dailyQuota,
    weight: p.weight,
    active: p.active,
  };
}

export interface SegmentView {
  id: string;
  key: string;
  name: string;
  teaorInclude: string[];
  teaorExclude: string[];
  fragments: string[];
  seedList: SeedEntry[];
  sourcingHint: SourcingHint;
  version: number;
  archived: boolean;
}

export function toSegmentView(s: Segment): SegmentView {
  return {
    id: s.id,
    key: s.key,
    name: s.name,
    teaorInclude: stringArray(s.teaorInclude),
    teaorExclude: stringArray(s.teaorExclude),
    fragments: stringArray(s.fragments),
    seedList: jsonArray(s.seedList)
      .filter((e): e is SeedEntry => !!e && typeof e === "object")
      .map((e) => ({
        ...(typeof e.name === "string" && e.name ? { name: e.name } : {}),
        ...(typeof e.taxNumber === "string" && e.taxNumber ? { taxNumber: e.taxNumber } : {}),
      })),
    sourcingHint: s.sourcingHint,
    version: s.version,
    archived: s.archived,
  };
}

/** Sum of the active profiles' quotas: the product's nightly target. */
export function productDailyQuota(profiles: readonly Pick<ProfileView, "active" | "dailyQuota">[]): number {
  return profiles.filter((p) => p.active).reduce((n, p) => n + p.dailyQuota, 0);
}
