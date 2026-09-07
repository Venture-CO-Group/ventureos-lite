import { PrismaClient } from "@prisma/client";
import { OWNER_GRANTS } from "../src/lib/grants";
import { NO_PASSWORD } from "../src/lib/auth/password";
import { provisionWorkspace, DEFAULT_ICP_CONFIG } from "../src/modules/workspaces/provision";
import {
  DEFAULT_MEETING_TYPES,
  DEFAULT_SLOT_CONFIG,
  DEFAULT_HORIZON_DAYS,
} from "../src/modules/meetings/booking-config";

const prisma = new PrismaClient();

// The ICP config, targets, pipelines and templates a workspace needs now live
// in ONE module, which the Owner-facing "New workspace" form also uses. They
// used to exist only here, so a workspace created through the product came out
// empty — see src/modules/workspaces/provision.ts.

// Seeded accounts get no usable password. `NO_PASSWORD` can never satisfy
// bcrypt, so a fresh install cannot be logged into until an Owner sets a real
// password with `npm run set-password` (see docs/DEPLOY.md).
const PLACEHOLDER_HASH = NO_PASSWORD;

async function main() {
  let workspace = await prisma.workspace.findFirst({
    where: { name: "Venture CO Group" },
  });
  if (!workspace) {
    workspace = await prisma.workspace.create({
      data: {
        name: "Venture CO Group",
        legalName: "Venture CO Group Kft.",
        icpConfig: DEFAULT_ICP_CONFIG,
        claudeBudget: 2,
        retentionDays: 365,
      },
    });
  }
  // Legal letterhead details used by document templates ({{workspace.*}}).
  await prisma.workspace.update({
    where: { id: workspace.id },
    data: {
      brand: { tax_id: "26841512-2-41", address: "1052 Budapest, Váci utca 1." },
    },
  });

  // The first Owner's address is deployment-specific (see docs/DEPLOY.md).
  const ownerEmail = process.env.SEED_OWNER_EMAIL ?? "director@ventureco.group";
  const tamas = await prisma.user.upsert({
    where: { email: ownerEmail },
    update: {},
    create: {
      email: ownerEmail,
      name: "Tamas",
      passwordHash: PLACEHOLDER_HASH,
    },
  });

  const fanni = await prisma.user.upsert({
    where: { email: "fanni@ventureco.group" },
    update: {},
    create: {
      email: "fanni@ventureco.group",
      name: "Fanni",
      passwordHash: PLACEHOLDER_HASH,
    },
  });

  // Tamas = Owner (all grants). Fanni = BDR (no grants until explicitly given).
  await prisma.membership.upsert({
    where: { userId_workspaceId: { userId: tamas.id, workspaceId: workspace.id } },
    update: { role: "OWNER", grants: OWNER_GRANTS },
    create: {
      userId: tamas.id,
      workspaceId: workspace.id,
      role: "OWNER",
      grants: OWNER_GRANTS,
    },
  });

  await prisma.membership.upsert({
    where: { userId_workspaceId: { userId: fanni.id, workspaceId: workspace.id } },
    update: { role: "BDR", grants: [] },
    create: {
      userId: fanni.id,
      workspaceId: workspace.id,
      role: "BDR",
      grants: [],
    },
  });

  // Public booking page for Tamas — meet.{domain}/tamas (spec §4.21).
  const existingBooking = await prisma.bookingPage.findUnique({ where: { slug: "tamas" } });
  if (!existingBooking) {
    await prisma.bookingPage.create({
      data: {
        workspaceId: workspace.id,
        hostUserId: tamas.id,
        slug: "tamas",
        title: "book a call with tamas",
        meetingTypes: DEFAULT_MEETING_TYPES as unknown as object[],
        config: { ...DEFAULT_SLOT_CONFIG, horizonDays: DEFAULT_HORIZON_DAYS },
      },
    });
  }

  const provisioned = await provisionWorkspace(prisma, workspace.id);

  console.log(
    `Seeded workspace "${workspace.name}" with Tamas (Owner), Fanni (BDR), ` +
      `${provisioned.targets} targets, ${provisioned.pipelines} deal pipelines and ` +
      `${provisioned.templates} base templates.`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
