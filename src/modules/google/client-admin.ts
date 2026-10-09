import { Prisma } from "@prisma/client";
import { prismaUnsafe, getWorkspaceClient } from "@/lib/db";
import { encryptSecret } from "@/lib/crypto";
import { GOOGLE_SCOPES } from "@/modules/meetings/google-oauth";
import { notifyGoogleReconnect } from "@/modules/notifications/notify";
import { isLiveOwner } from "@/modules/workspaces/admin";
import { ENV_CLIENT_REF, googleRedirectUri, parseClientRef, workspaceClientRef } from "./clients";

/**
 * Administering a workspace's own Google OAuth client (item 3).
 *
 * Plain functions taking the actor's id — the rules live here and are tested
 * here; ./client-actions.ts only adds who the actor is.
 *
 * ── REPLACING A CLIENT IS NOT EDITING IT ───────────────────────────────────
 *
 * A refresh token belongs to the client id that issued it. Changing the client
 * id therefore kills every connection made through the old one, and so does
 * deleting it. Both are done as "remove the row, (create a new one)" so the
 * old clientRef stops resolving, and every credential it issued is marked for
 * reconnection and its owner told — after the Owner has seen the number and
 * confirmed it. Rotating only the SECRET keeps the client id and therefore
 * every token: that is an edit, in place, and disconnects nobody.
 */

export const REQUIRED_APIS = ["Gmail API", "Google Calendar API"] as const;

export interface GoogleClientConnection {
  credentialId: string;
  userName: string;
  accountEmail: string | null;
  /** Calendar role, and whether a mailbox rides on it. */
  purpose: string;
  mailbox: boolean;
  /** workspace | installation | replaced */
  client: "workspace" | "installation" | "replaced";
}

export interface GoogleClientPanel {
  configured: boolean;
  clientId: string | null;
  /** Never the secret — only that one is stored. */
  secretSet: boolean;
  status: string | null;
  lastTestedAt: string | null;
  lastError: string | null;
  redirectUri: string | null;
  scopes: string[];
  requiredApis: readonly string[];
  /** Is the installation's own client available as the fallback? */
  envFallback: boolean;
  connections: GoogleClientConnection[];
}

async function currentRow(workspaceId: string) {
  return getWorkspaceClient(workspaceId).workspaceGoogleClient.findFirst({ where: { workspaceId } });
}

/** Google credentials of this workspace's members, with the client each came from. */
async function connectionsOf(workspaceId: string, currentRef: string | null): Promise<GoogleClientConnection[]> {
  const members = await prismaUnsafe.membership.findMany({
    where: { workspaceId, state: { in: ["ACTIVE", "SUSPENDED"] } },
    select: { userId: true, user: { select: { name: true } } },
  });
  if (members.length === 0) return [];
  const names = new Map(members.map((m) => [m.userId, m.user.name]));
  const creds = await prismaUnsafe.googleCredential.findMany({
    where: { userId: { in: [...names.keys()] } },
    select: { id: true, userId: true, accountEmail: true, purpose: true, clientRef: true, invalidatedAt: true },
    orderBy: { createdAt: "asc" },
  });
  const boxes = await prismaUnsafe.mailAccount.findMany({
    where: { credentialId: { in: creds.map((c) => c.id) } },
    select: { credentialId: true },
  });
  const withBox = new Set(boxes.map((b) => b.credentialId));
  return (
    creds
      // Only connections made for THIS workspace, or the installation's —
      // another workspace's client is that workspace's business.
      .filter((c) => {
        const parsed = parseClientRef(c.clientRef);
        return !parsed || parsed.workspaceId === workspaceId;
      })
      .map((c) => ({
        credentialId: c.id,
        userName: names.get(c.userId) ?? "—",
        accountEmail: c.accountEmail,
        purpose: c.purpose,
        mailbox: withBox.has(c.id),
        client: c.invalidatedAt
          ? ("replaced" as const)
          : (c.clientRef ?? ENV_CLIENT_REF) === ENV_CLIENT_REF
            ? ("installation" as const)
            : c.clientRef === currentRef
              ? ("workspace" as const)
              : ("replaced" as const),
      }))
  );
}

export async function googleClientPanel(workspaceId: string): Promise<GoogleClientPanel> {
  const row = await currentRow(workspaceId);
  const ref = row ? workspaceClientRef(workspaceId, row.id) : null;
  return {
    configured: !!row,
    clientId: row?.clientId ?? null,
    secretSet: !!row,
    status: row?.status ?? null,
    lastTestedAt: row?.lastTestedAt?.toISOString() ?? null,
    lastError: row?.lastError ?? null,
    redirectUri: googleRedirectUri(),
    scopes: [...GOOGLE_SCOPES],
    requiredApis: REQUIRED_APIS,
    envFallback: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    connections: await connectionsOf(workspaceId, ref),
  };
}

/** How many live connections a change would cut, and whose. */
async function issuedBy(ref: string) {
  return prismaUnsafe.googleCredential.findMany({
    where: { clientRef: ref, invalidatedAt: null },
    select: { id: true, userId: true, accountEmail: true },
  });
}

export async function affectedByChange(
  workspaceId: string,
  next: { clientId: string } | null,
): Promise<number> {
  const row = await currentRow(workspaceId);
  if (!row) return 0;
  // Same client id → a secret rotation, which cuts nothing.
  if (next && next.clientId.trim() === row.clientId) return 0;
  return (await issuedBy(workspaceClientRef(workspaceId, row.id))).length;
}

/** Mark a client's connections dead, flag their mailboxes, tell their owners. */
async function invalidateIssuedBy(workspaceId: string, ref: string, why: string, now: Date): Promise<number> {
  const creds = await issuedBy(ref);
  if (creds.length === 0) return 0;
  const ids = creds.map((c) => c.id);
  await prismaUnsafe.googleCredential.updateMany({ where: { id: { in: ids } }, data: { invalidatedAt: now } });
  await prismaUnsafe.mailAccount.updateMany({
    where: { credentialId: { in: ids } },
    data: { health: "reconnect_needed", lastError: why },
  });
  for (const userId of new Set(creds.map((c) => c.userId))) {
    await notifyGoogleReconnect({ workspaceId, userId, reason: why, changeKey: `${ref}:${now.toISOString()}` });
  }
  return creds.length;
}

export type SaveResult =
  | { ok: true; replaced: boolean; invalidated: number }
  | { ok: false; error: string }
  | { ok: false; needsConfirm: true; affected: number };

/**
 * Create, rotate the secret of, or replace the workspace's client.
 *
 * `confirmAffected` must equal the number of connections the change would cut;
 * a mismatch (including "not sent") returns the number instead of saving, so
 * the screen can ask. Matching the count rather than a boolean means a
 * confirmation shown for 2 connections cannot approve a change that, by the
 * time it lands, cuts 5.
 */
export async function saveGoogleClient(input: {
  actorId: string;
  workspaceId: string;
  clientId: string;
  clientSecret: string;
  confirmAffected?: number;
  now?: Date;
}): Promise<SaveResult> {
  const now = input.now ?? new Date();
  if (!(await isLiveOwner(input.actorId, input.workspaceId))) {
    return { ok: false, error: "Only an Owner of this workspace can configure its Google client." };
  }
  const clientId = input.clientId.trim();
  const secret = input.clientSecret.trim();
  const db = getWorkspaceClient(input.workspaceId);
  const row = await currentRow(input.workspaceId);

  if (!row) {
    if (!secret) return { ok: false, error: "Paste the client secret too." };
    await db.workspaceGoogleClient.create({
      data: {
        workspaceId: input.workspaceId,
        clientId,
        clientSecretEnc: encryptSecret(secret),
        createdBy: input.actorId,
      },
    });
    await audit(input.workspaceId, input.actorId, "google_client.create", { clientId });
    return { ok: true, replaced: false, invalidated: 0 };
  }

  if (row.clientId === clientId) {
    // A secret rotation (or nothing): every token stays valid.
    if (secret) {
      await db.workspaceGoogleClient.update({
        where: { id: row.id },
        data: { clientSecretEnc: encryptSecret(secret), status: "untested", lastError: null },
      });
      await audit(input.workspaceId, input.actorId, "google_client.rotate_secret", { clientId });
    }
    return { ok: true, replaced: false, invalidated: 0 };
  }

  if (!secret) return { ok: false, error: "A new client id needs its own secret." };
  const oldRef = workspaceClientRef(input.workspaceId, row.id);
  const affected = (await issuedBy(oldRef)).length;
  if (input.confirmAffected !== affected) return { ok: false, needsConfirm: true, affected };

  await db.workspaceGoogleClient.delete({ where: { id: row.id } });
  await db.workspaceGoogleClient.create({
    data: {
      workspaceId: input.workspaceId,
      clientId,
      clientSecretEnc: encryptSecret(secret),
      createdBy: input.actorId,
    },
  });
  const invalidated = await invalidateIssuedBy(
    input.workspaceId,
    oldRef,
    "This workspace's Google client was replaced.",
    now,
  );
  await audit(input.workspaceId, input.actorId, "google_client.replace", {
    from: row.clientId,
    to: clientId,
    invalidated,
  });
  return { ok: true, replaced: true, invalidated };
}

export async function deleteGoogleClient(input: {
  actorId: string;
  workspaceId: string;
  confirmAffected?: number;
  now?: Date;
}): Promise<{ ok: true; invalidated: number } | { ok: false; error: string } | { ok: false; needsConfirm: true; affected: number }> {
  const now = input.now ?? new Date();
  if (!(await isLiveOwner(input.actorId, input.workspaceId))) {
    return { ok: false, error: "Only an Owner of this workspace can remove its Google client." };
  }
  const row = await currentRow(input.workspaceId);
  if (!row) return { ok: true, invalidated: 0 };
  const ref = workspaceClientRef(input.workspaceId, row.id);
  const affected = (await issuedBy(ref)).length;
  if (input.confirmAffected !== affected) return { ok: false, needsConfirm: true, affected };

  await getWorkspaceClient(input.workspaceId).workspaceGoogleClient.delete({ where: { id: row.id } });
  const invalidated = await invalidateIssuedBy(
    input.workspaceId,
    ref,
    "This workspace's Google client was removed.",
    now,
  );
  await audit(input.workspaceId, input.actorId, "google_client.delete", { clientId: row.clientId, invalidated });
  return { ok: true, invalidated };
}

async function audit(workspaceId: string, actorUserId: string, action: string, meta: Record<string, unknown>) {
  await getWorkspaceClient(workspaceId).auditLog.create({
    data: {
      workspaceId,
      actorUserId,
      action,
      entityType: "WorkspaceGoogleClient",
      entityId: workspaceId,
      meta: meta as Prisma.InputJsonValue,
    },
  });
}
