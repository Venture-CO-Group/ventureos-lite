"use server";

import { revalidatePath } from "next/cache";
import { getWorkspaceClient } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { isOwner, hasGrant } from "@/lib/authz";
import {
  productInputSchema,
  profileInputSchema,
  segmentInputSchema,
  slugify,
  toProductView,
  toProfileView,
  toSegmentView,
  stringArray,
  type ProductView,
  type ProfileView,
  type SegmentView,
} from "./catalog";
import { loadSegments } from "./segments";

/**
 * Products, ICP profiles and the segment taxonomy (playbook-v6 F1, spec
 * §4.43.1–2).
 *
 * Products and profiles are Owner-edited and BDR-readable: what we sell and to
 * whom is the Owner's decision, and it is what every nightly run spends quota
 * and Claude budget on. Segment fragments are the daily tuning knob
 * (§9bis/1), so they sit behind `settings.manage`, which a BDR carries.
 *
 * Every mutation is audit-logged and tenant-guarded.
 */

type Result<T = unknown> = ({ ok: true } & T) | { ok: false; error: string };

const PATHS = ["/outbound", "/outbound/products"];
function refresh(): void {
  for (const p of PATHS) revalidatePath(p);
}

function firstIssue(e: { issues: Array<{ message: string; path: (string | number)[] }> }): string {
  const i = e.issues[0];
  return i ? `${i.path.join(".") || "input"}: ${i.message}` : "Invalid input.";
}

// ---- reads -----------------------------------------------------------------

export async function listProducts(): Promise<ProductView[]> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const rows = await db.product.findMany({
    include: { references: true, profiles: { orderBy: { createdAt: "asc" } } },
    orderBy: [{ status: "asc" }, { priority: "desc" }, { name: "asc" }],
  });
  return rows.map(toProductView);
}

export async function listSegments(): Promise<SegmentView[]> {
  const { workspaceId } = await getActiveContext();
  return loadSegments(getWorkspaceClient(workspaceId), workspaceId);
}

export async function catalogPermissions(): Promise<{ canEditProducts: boolean; canEditSegments: boolean }> {
  const [owner, settings] = await Promise.all([isOwner(), hasGrant("settings.manage")]);
  return { canEditProducts: owner, canEditSegments: settings };
}

// ---- products --------------------------------------------------------------

export async function saveProduct(raw: unknown): Promise<Result<{ id: string }>> {
  if (!(await isOwner())) return { ok: false, error: "Only an Owner can edit products." };
  const parsed = productInputSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const input = parsed.data;
  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  const slug = input.slug || slugify(input.name);
  if (!slug) return { ok: false, error: "The product needs a name with at least one letter." };
  const clash = await db.product.findFirst({
    where: { slug, ...(input.id ? { NOT: { id: input.id } } : {}) },
    select: { id: true },
  });
  if (clash) return { ok: false, error: `Another product already uses the slug "${slug}".` };

  const data = {
    name: input.name,
    slug,
    category: input.category,
    partner: input.category === "PARTNER_SOLUTION" ? input.partner : null,
    problemSolved: input.problemSolved,
    valueProps: input.valueProps,
    proofPoints: input.proofPoints,
    priceBand: input.priceBand,
    assets: input.assets,
    status: input.status,
    language: input.language,
    priority: input.priority,
  };

  let id = input.id;
  if (id) {
    const before = await db.product.findUnique({ where: { id }, include: { references: true } });
    if (!before) return { ok: false, error: "That product no longer exists." };
    await db.product.update({ where: { id }, data });
  } else {
    id = (await db.product.create({ data: { workspaceId, ...data } })).id;
  }

  // References are replaced as a set: their order is meaningful and they have
  // no identity anything else points at.
  await db.productReference.deleteMany({ where: { productId: id } });
  if (input.references.length > 0) {
    await db.productReference.createMany({
      data: input.references.map((r, position) => ({
        workspaceId,
        productId: id!,
        companyName: r.companyName,
        taxNumber: r.taxNumber,
        isClient: r.isClient,
        note: r.note,
        position,
      })),
    });
  }

  await db.auditLog.create({
    data: {
      workspaceId,
      actorUserId: userId,
      action: input.id ? "outbound.product.updated" : "outbound.product.created",
      entityType: "Product",
      entityId: id,
      meta: {
        name: input.name,
        status: input.status,
        // The flag that decides what copy may say is worth a line of its own.
        nameableReferences: input.references.filter((r) => r.isClient).map((r) => r.companyName),
      },
    },
  });
  refresh();
  return { ok: true, id };
}

export async function deleteProduct(id: string): Promise<Result> {
  if (!(await isOwner())) return { ok: false, error: "Only an Owner can delete products." };
  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const product = await db.product.findUnique({ where: { id }, select: { id: true, name: true } });
  if (!product) return { ok: false, error: "That product no longer exists." };
  await db.product.delete({ where: { id } });
  await db.auditLog.create({
    data: {
      workspaceId,
      actorUserId: userId,
      action: "outbound.product.deleted",
      entityType: "Product",
      entityId: id,
      meta: { name: product.name },
    },
  });
  refresh();
  return { ok: true };
}

// ---- profiles --------------------------------------------------------------

export async function saveProfile(raw: unknown): Promise<Result<{ profile: ProfileView }>> {
  if (!(await isOwner())) return { ok: false, error: "Only an Owner can edit ICP profiles." };
  const parsed = profileInputSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const input = parsed.data;
  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  const product = await db.product.findUnique({ where: { id: input.productId }, select: { id: true } });
  if (!product) return { ok: false, error: "That product no longer exists." };

  // A profile pointing at a segment the workspace does not have would harvest
  // nothing and say nothing about why.
  const segments = await loadSegments(db, workspaceId);
  const known = new Set(segments.filter((s) => !s.archived).map((s) => s.key));
  const unknown = input.segmentKeys.filter((k) => !known.has(k));
  if (unknown.length > 0) return { ok: false, error: `Unknown segment: ${unknown.join(", ")}.` };

  const data = {
    name: input.name,
    segmentKeys: input.segmentKeys,
    sizeBands: input.sizeBands,
    includeUnknownSize: input.includeUnknownSize,
    revenueMin: input.revenueMin === null ? null : BigInt(input.revenueMin),
    revenueMax: input.revenueMax === null ? null : BigInt(input.revenueMax),
    counties: input.counties,
    cities: input.cities,
    legalForms: input.legalForms,
    foundedAfter: input.foundedAfter,
    foundedBefore: input.foundedBefore,
    statusRequired: input.statusRequired,
    requiresWebsite: input.requiresWebsite,
    auditScoreMin: input.auditScoreMin,
    auditScoreMax: input.auditScoreMax,
    requiredSignals: input.requiredSignals,
    contactRequirement: input.contactRequirement,
    excludeExistingClients: input.excludeExistingClients,
    mode: input.mode,
    dailyQuota: input.dailyQuota,
    weight: input.weight,
    active: input.active,
  };

  const row = input.id
    ? await db.icpProfile.update({ where: { id: input.id }, data })
    : await db.icpProfile.create({ data: { workspaceId, productId: input.productId, ...data } });

  await db.auditLog.create({
    data: {
      workspaceId,
      actorUserId: userId,
      action: input.id ? "outbound.profile.updated" : "outbound.profile.created",
      entityType: "IcpProfile",
      entityId: row.id,
      meta: { productId: input.productId, name: input.name, dailyQuota: input.dailyQuota, active: input.active },
    },
  });
  refresh();
  return { ok: true, profile: toProfileView(row) };
}

export async function deleteProfile(id: string): Promise<Result> {
  if (!(await isOwner())) return { ok: false, error: "Only an Owner can delete ICP profiles." };
  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const row = await db.icpProfile.findUnique({ where: { id }, select: { id: true, name: true, productId: true } });
  if (!row) return { ok: false, error: "That profile no longer exists." };
  await db.icpProfile.delete({ where: { id } });
  await db.auditLog.create({
    data: {
      workspaceId,
      actorUserId: userId,
      action: "outbound.profile.deleted",
      entityType: "IcpProfile",
      entityId: id,
      meta: { name: row.name, productId: row.productId },
    },
  });
  refresh();
  return { ok: true };
}

// ---- segments --------------------------------------------------------------

function sameList(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export async function saveSegment(raw: unknown): Promise<Result<{ segment: SegmentView }>> {
  if (!(await hasGrant("settings.manage"))) {
    return { ok: false, error: "You do not have permission to edit segments." };
  }
  const parsed = segmentInputSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const input = parsed.data;
  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  const before = await db.segment.findUnique({ where: { id: input.id } });
  if (!before) return { ok: false, error: "That segment no longer exists." };

  const dedupe = (xs: string[]) => [...new Set(xs.map((x) => x.trim()).filter(Boolean))];
  const fragments = dedupe(input.fragments);
  const seedList = input.seedList.map((e) => ({
    ...(e.name ? { name: e.name } : {}),
    ...(e.taxNumber ? { taxNumber: e.taxNumber } : {}),
  }));
  const teaorInclude = dedupe(input.teaorInclude);
  const teaorExclude = dedupe(input.teaorExclude);

  // A new version whenever what the harvest or the filter does changes — so
  // a fragment's measured yield is always read against the set it ran in.
  const contentChanged =
    !sameList(stringArray(before.fragments), fragments) ||
    !sameList(before.seedList, seedList) ||
    !sameList(stringArray(before.teaorInclude), teaorInclude) ||
    !sameList(stringArray(before.teaorExclude), teaorExclude);

  const row = await db.segment.update({
    where: { id: input.id },
    data: {
      name: input.name,
      fragments,
      seedList,
      teaorInclude,
      teaorExclude,
      sourcingHint: input.sourcingHint,
      archived: input.archived,
      ...(contentChanged ? { version: { increment: 1 } } : {}),
    },
  });

  await db.auditLog.create({
    data: {
      workspaceId,
      actorUserId: userId,
      action: "outbound.segment.updated",
      entityType: "Segment",
      entityId: row.id,
      meta: {
        key: row.key,
        version: row.version,
        fragmentsAdded: fragments.filter((f) => !stringArray(before.fragments).includes(f)),
        fragmentsRemoved: stringArray(before.fragments).filter((f) => !fragments.includes(f)),
      },
    },
  });
  revalidatePath("/outbound/segments");
  return { ok: true, segment: toSegmentView(row) };
}
