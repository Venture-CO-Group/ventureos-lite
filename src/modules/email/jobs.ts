import { getWorkspaceClient, prismaUnsafe } from "@/lib/db";
import { GmailProvider } from "./gmail";
import { MailAuthError, MailRateLimitError, type MailCredentials, type MailProvider } from "./provider";
import { buildMatchIndex } from "./scope";
import { scopeFromIndex } from "./matching";
import { buildSyncQueries, backfillWindows, BACKFILL_WINDOW_DAYS } from "./gmail-query";
import { ingestMessage } from "./ingest";
import { notifyReplyReceived, notifySyncFailed } from "../notifications/notify";

/**
 * The sync pass (playbook-v2 P2b).
 *
 * Two modes over one code path: a BACKFILL walks 90 days backwards in windows,
 * an INCREMENTAL pass asks for everything since the watermark. Both build their
 * queries from the CRM index, so neither can see mail the workspace does not
 * already know about.
 *
 * Every pass is bounded. A sync that can run for an unbounded time is a sync
 * that eventually overlaps itself, and two passes writing the same thread is
 * how duplicates appear.
 */
const MAX_MESSAGES_PER_PASS = 200;

export interface MailSyncJobData {
  accountId: string;
}

type Health = "ok" | "reconnect_needed" | "rate_limited" | "error";

async function setHealth(accountId: string, health: Health, error?: string): Promise<void> {
  const account = await prismaUnsafe.mailAccount.update({
    where: { id: accountId },
    data: {
      health,
      lastError: error?.slice(0, 500) ?? null,
      ...(health === "ok" ? { lastSyncAt: new Date() } : {}),
    },
    select: { id: true, workspaceId: true, userId: true, accountEmail: true },
  });

  // P6/1. The one chokepoint every failure passes through, so the notification
  // is raised once here rather than at five call sites.
  //
  // `rate_limited` is deliberately NOT notified: it is transient, the backoff
  // resolves it without anyone doing anything, and telling a person about a
  // problem they cannot act on is how a bell gets ignored.
  if (health === "reconnect_needed" || health === "error") {
    await notifySyncFailed({
      workspaceId: account.workspaceId,
      accountId: account.id,
      userId: account.userId,
      address: account.accountEmail,
      health,
    });
  }
}

/**
 * Sync one mailbox.
 *
 * Returns how many messages were stored, for the worker log. Never throws for
 * an expected condition — an expired token and a rate limit are both states the
 * mailbox can legitimately be in, and both are recorded on the account so
 * Settings can say so rather than the job dying silently.
 */
export async function processMailSync(
  data: MailSyncJobData,
  provider: MailProvider = new GmailProvider(),
): Promise<number> {
  const account = await prismaUnsafe.mailAccount.findUnique({
    where: { id: data.accountId },
  });
  if (!account || !account.enabled) return 0;

  const credential = account.credentialId
    ? await prismaUnsafe.googleCredential.findUnique({ where: { id: account.credentialId } })
    : null;
  if (!credential) {
    await setHealth(account.id, "reconnect_needed", "no credential on this account");
    return 0;
  }
  if (credential.invalidatedAt) {
    // Its OAuth client was replaced or deleted; the refresh token is dead.
    await setHealth(account.id, "reconnect_needed", "the Google client that issued this connection was replaced");
    return 0;
  }

  const creds: MailCredentials = {
    accessToken: credential.accessToken,
    refreshToken: credential.refreshToken,
    expiryDate: credential.expiryDate,
    clientRef: credential.clientRef,
  };

  const db = getWorkspaceClient(account.workspaceId);
  const index = await buildMatchIndex(db, [account.accountEmail]);
  const scope = scopeFromIndex(index);

  // Nothing known, nothing to ask for. Not an error — a workspace with no lead
  // addresses yet simply has no mail to sync, and issuing a query anyway would
  // mean asking for the whole mailbox.
  if (scope.addresses.length === 0 && scope.domains.length === 0) {
    await setHealth(account.id, "ok");
    return 0;
  }

  const now = new Date();
  const windows = account.backfillDone
    ? [{ after: account.watermark ?? new Date(now.getTime() - 86_400_000) }]
    : nextBackfillWindow(account.backfillCursor, now);

  let stored = 0;
  let latestSeen = account.watermark ?? null;

  try {
    for (const window of windows) {
      for (const query of buildSyncQueries(scope, window)) {
        let pageToken: string | undefined;

        do {
          const page = await provider.listMessageIds(creds, query, pageToken);
          if (page.refreshed) await persistRefresh(credential.id, page.refreshed, creds);

          for (const { messageId } of page.ids) {
            if (stored >= MAX_MESSAGES_PER_PASS) break;

            // Skip anything already stored before spending a fetch on it.
            const seen = await db.emailMessage.findFirst({
              where: { providerMessageId: messageId },
              select: { id: true },
            });
            if (seen) continue;

            const { message, refreshed } = await provider.getMessage(creds, messageId);
            if (refreshed) await persistRefresh(credential.id, refreshed, creds);

            const result = ingestMessage(message, index);
            await persistMessage(db, account.id, account.workspaceId, result);
            stored += 1;
            if (!latestSeen || message.headers.date > latestSeen) {
              latestSeen = message.headers.date;
            }
          }

          pageToken = page.nextPageToken ?? undefined;
        } while (pageToken && stored < MAX_MESSAGES_PER_PASS);

        if (stored >= MAX_MESSAGES_PER_PASS) break;
      }
      if (stored >= MAX_MESSAGES_PER_PASS) break;
    }

    await prismaUnsafe.mailAccount.update({
      where: { id: account.id },
      data: {
        health: "ok",
        lastError: null,
        lastSyncAt: now,
        watermark: latestSeen ?? account.watermark,
        ...backfillProgress(account.backfillCursor, account.backfillDone, now, stored),
      },
    });
    return stored;
  } catch (e) {
    if (e instanceof MailAuthError) {
      // Not retried: only reconnecting fixes it, and retrying a revoked grant
      // forever is how a queue fills with work that can never succeed.
      await setHealth(account.id, "reconnect_needed", e.message);
      return stored;
    }
    if (e instanceof MailRateLimitError) {
      await setHealth(account.id, "rate_limited", e.message);
      return stored;
    }
    await setHealth(account.id, "error", (e as Error).message);
    return stored;
  }
}

/** One window at a time, so a backfill is resumable and reports progress. */
function nextBackfillWindow(
  cursor: Date | null,
  now: Date,
): Array<{ after?: Date; before?: Date }> {
  const windows = backfillWindows(now);
  if (!cursor) return [windows[0]!];
  const next = windows.find((w) => w.before && w.before.getTime() <= cursor.getTime());
  return next ? [next] : [];
}

function backfillProgress(
  cursor: Date | null,
  done: boolean,
  now: Date,
  _stored: number,
): { backfillCursor?: Date; backfillDone?: boolean } {
  if (done) return {};
  const dayMs = 86_400_000;
  const nextCursor = new Date(
    (cursor?.getTime() ?? now.getTime()) - BACKFILL_WINDOW_DAYS * dayMs,
  );
  const oldest = new Date(now.getTime() - 90 * dayMs);
  return nextCursor.getTime() <= oldest.getTime()
    ? { backfillCursor: nextCursor, backfillDone: true }
    : { backfillCursor: nextCursor };
}

async function persistRefresh(
  credentialId: string,
  refreshed: Partial<MailCredentials>,
  creds: MailCredentials,
): Promise<void> {
  // Keep the in-memory creds in step too, or the rest of this pass keeps
  // presenting the token Google just replaced.
  if (refreshed.accessToken) creds.accessToken = refreshed.accessToken;
  if (refreshed.expiryDate) creds.expiryDate = refreshed.expiryDate;
  await prismaUnsafe.googleCredential.update({
    where: { id: credentialId },
    data: {
      ...(refreshed.accessToken ? { accessToken: refreshed.accessToken } : {}),
      ...(refreshed.expiryDate ? { expiryDate: refreshed.expiryDate } : {}),
    },
  });
}

type WorkspaceDb = ReturnType<typeof getWorkspaceClient>;

async function persistMessage(
  db: WorkspaceDb,
  accountId: string,
  workspaceId: string,
  result: ReturnType<typeof ingestMessage>,
): Promise<void> {
  const { message, match } = result;

  const thread = await db.emailThread.upsert({
    where: {
      accountId_providerThreadId: {
        accountId,
        providerThreadId: message.providerThreadId,
      },
    },
    create: {
      workspaceId,
      accountId,
      providerThreadId: message.providerThreadId,
      subject: message.subject,
      leadId: match?.leadId ?? null,
      companyId: match?.companyId ?? null,
      matchType: match?.matchType ?? "address",
      lastMessageAt: message.sentAt,
      messageCount: 1,
      unread: message.unread,
    },
    update: {
      lastMessageAt: message.sentAt,
      messageCount: { increment: 1 },
      unread: message.unread ? true : undefined,
      // leadId/matchType are deliberately NOT updated. A thread linked by hand
      // keeps that link — re-matching on every new message would silently undo
      // the operator's correction, which is the one thing a learned link
      // exists to prevent.
    },
    select: { id: true, leadId: true },
  });
  const threadLeadId = thread.leadId;

  const stored = await db.emailMessage.create({
    data: {
      workspaceId,
      threadId: thread.id,
      providerMessageId: message.providerMessageId,
      direction: message.direction,
      fromAddress: message.fromAddress,
      toAddresses: message.toAddresses,
      ccAddresses: message.ccAddresses,
      subject: message.subject,
      snippet: message.snippet,
      bodyHtml: message.bodyHtml,
      bodyText: message.bodyText,
      hasAttachments: message.hasAttachments,
      attachments: message.attachments as unknown as object,
      sentAt: message.sentAt,
    },
    select: { id: true },
  });

  // P6/1: an inbound message on a matched lead is news. Outbound is not — it is
  // the user's own send coming back through the sync.
  if (message.direction === "INBOUND" && threadLeadId) {
    await notifyReplyReceived({
      workspaceId,
      leadId: threadLeadId,
      threadId: stored.id,
      snippet: message.snippet,
    });
  }
}

/**
 * Sweep every enabled mailbox. Scheduled every two minutes.
 *
 * Accounts needing a reconnect are skipped rather than retried — the state is
 * already on the row, and Settings shows it.
 */
export async function processMailSyncSweep(): Promise<number> {
  const accounts = await prismaUnsafe.mailAccount.findMany({
    where: { enabled: true, health: { in: ["ok", "rate_limited"] } },
    select: { id: true },
    take: 50,
  });

  let total = 0;
  for (const account of accounts) {
    total += await processMailSync({ accountId: account.id });
  }
  return total;
}
