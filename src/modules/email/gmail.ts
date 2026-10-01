/**
 * Gmail implementation of MailProvider (playbook-v2 P2b).
 *
 * Token refresh mirrors the calendar provider deliberately: same endpoint, same
 * "return refreshed creds for the caller to persist" contract, so there is one
 * shape to understand rather than two.
 *
 * Every failure is classified before it leaves this file. A 401 means
 * reconnect and must not be retried; a 429 or 403-rateLimitExceeded means slow
 * down and must be. Collapsing those into one Error is how a sync ends up
 * hammering an endpoint that is telling it to stop, or silently dying on an
 * expired token nobody was told about.
 */
import {
  MailAuthError,
  MailRateLimitError,
  type FetchedMessage,
  type MailAttachmentMeta,
  type MailCredentials,
  type MailProvider,
  type MessagePage,
  type RefreshedCredentials,
} from "./provider";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://gmail.googleapis.com/gmail/v1/users/me";
/** Gmail caps at 500; 100 keeps a single page cheap to process. */
const PAGE_SIZE = 100;

interface GmailHeader {
  name: string;
  value: string;
}
interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailPart[];
}
interface GmailMessage {
  id: string;
  threadId: string;
  snippet?: string;
  labelIds?: string[];
  payload?: GmailPart;
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

/** Addresses out of a header value, which may be "Name <a@b.hu>, c@d.hu". */
export interface ReplyMimeInput {
  to: string[];
  cc?: string[];
  subject: string;
  bodyText: string;
  bodyHtml?: string;
  inReplyToMessageId?: string;
}

/**
 * The message as it goes on the wire.
 *
 * Pulled out of the send call so it can be asserted on directly — the playbook
 * asks for exactly that ("toggle-off mail contains no pixel and no rewritten
 * links (assert on raw MIME)"), and a promise about what leaves the building
 * is worth checking where it leaves.
 */
export function buildReplyMime(input: ReplyMimeInput): string {
  const lines = [
    `To: ${input.to.join(", ")}`,
    ...(input.cc?.length ? [`Cc: ${input.cc.join(", ")}`] : []),
    `Subject: ${input.subject}`,
    ...(input.inReplyToMessageId
      ? [`In-Reply-To: ${input.inReplyToMessageId}`, `References: ${input.inReplyToMessageId}`]
      : []),
    "MIME-Version: 1.0",
    `Content-Type: ${input.bodyHtml ? "text/html" : "text/plain"}; charset=UTF-8`,
    "",
    input.bodyHtml ?? input.bodyText,
  ];
  return lines.join("\r\n");
}

/** Gmail wants base64url with no padding. */
export function encodeMime(mime: string): string {
  return Buffer.from(mime, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function parseAddressList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((part) => {
      const angle = /<([^>]+)>/.exec(part);
      return (angle ? angle[1]! : part).trim().toLowerCase();
    })
    .filter((a) => a.includes("@"));
}

export function parseDisplayName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const name = raw.split("<")[0]!.trim().replace(/^"|"$/g, "");
  return name.length > 0 && name.includes("@") === false ? name : null;
}

/** Walk the MIME tree for the best text and html parts, plus attachments. */
export function flattenParts(payload: GmailPart | undefined): {
  html: string | null;
  text: string | null;
  attachments: MailAttachmentMeta[];
} {
  let html: string | null = null;
  let text: string | null = null;
  const attachments: MailAttachmentMeta[] = [];

  const walk = (part: GmailPart | undefined) => {
    if (!part) return;
    const mime = (part.mimeType ?? "").toLowerCase();

    if (part.filename && part.body?.attachmentId) {
      attachments.push({
        filename: part.filename,
        mimeType: part.mimeType ?? "application/octet-stream",
        sizeBytes: part.body.size ?? 0,
        providerAttachmentId: part.body.attachmentId,
      });
      return;
    }
    if (mime === "text/html" && part.body?.data && html === null) {
      html = decodeBase64Url(part.body.data);
    } else if (mime === "text/plain" && part.body?.data && text === null) {
      text = decodeBase64Url(part.body.data);
    }
    for (const child of part.parts ?? []) walk(child);
  };

  walk(payload);
  return { html, text, attachments };
}

export function toFetchedMessage(raw: GmailMessage): FetchedMessage {
  const headers = raw.payload?.headers ?? [];
  const header = (name: string) =>
    headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? null;

  const { html, text, attachments } = flattenParts(raw.payload);
  const dateHeader = header("Date");
  const parsedDate = dateHeader ? new Date(dateHeader) : null;

  return {
    providerMessageId: raw.id,
    providerThreadId: raw.threadId,
    headers: {
      from: parseAddressList(header("From"))[0] ?? "",
      to: parseAddressList(header("To")),
      cc: parseAddressList(header("Cc")),
      subject: header("Subject"),
      // A message with an unparseable Date still belongs on the timeline; the
      // fetch time is wrong but bounded, where Invalid Date poisons every sort
      // it touches.
      date: parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate : new Date(),
    },
    snippet: raw.snippet ?? "",
    bodyHtml: html,
    bodyText: text,
    attachments,
    unread: (raw.labelIds ?? []).includes("UNREAD"),
  };
}

export class GmailProvider implements MailProvider {
  readonly name = "gmail";

  constructor(private readonly doFetch: typeof fetch = fetch) {}

  private async ensureToken(
    creds: MailCredentials,
  ): Promise<{ accessToken: string; refreshed?: RefreshedCredentials }> {
    const stillValid =
      creds.expiryDate != null && creds.expiryDate.getTime() > Date.now() + 60_000;
    if (stillValid) return { accessToken: creds.accessToken };
    if (!creds.refreshToken) {
      throw new MailAuthError("mailbox_not_connected");
    }

    const res = await this.doFetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID ?? "",
        client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
        refresh_token: creds.refreshToken,
        grant_type: "refresh_token",
      }),
    });
    if (!res.ok) {
      // A refresh token Google refuses is not a transient failure: the user
      // revoked access or the grant expired, and only reconnecting fixes it.
      throw new MailAuthError(`google_token_refresh ${res.status}`);
    }
    const data = (await res.json()) as { access_token: string; expires_in: number };
    return {
      accessToken: data.access_token,
      refreshed: {
        accessToken: data.access_token,
        expiryDate: new Date(Date.now() + data.expires_in * 1000),
      },
    };
  }

  private async call(
    accessToken: string,
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const res = await this.doFetch(`${API}${path}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        authorization: `Bearer ${accessToken}`,
      },
    });

    if (res.status === 401) throw new MailAuthError("gmail_unauthorized");
    if (res.status === 429 || res.status === 403) {
      const retryAfter = Number(res.headers.get("retry-after"));
      // 403 covers both "rate limited" and "insufficient permission"; only the
      // first is worth retrying, and the body is what distinguishes them.
      const body = await res.clone().text();
      if (res.status === 403 && !/rateLimitExceeded|userRateLimitExceeded/i.test(body)) {
        throw new MailAuthError(`gmail_forbidden: ${body.slice(0, 200)}`);
      }
      throw new MailRateLimitError(
        "gmail_rate_limited",
        Number.isFinite(retryAfter) ? retryAfter : null,
      );
    }
    if (!res.ok) throw new Error(`gmail ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res;
  }

  async listMessageIds(
    creds: MailCredentials,
    query: string,
    pageToken?: string,
  ): Promise<MessagePage> {
    const { accessToken, refreshed } = await this.ensureToken(creds);
    const params = new URLSearchParams({ q: query, maxResults: String(PAGE_SIZE) });
    if (pageToken) params.set("pageToken", pageToken);

    const res = await this.call(accessToken, `/messages?${params.toString()}`);
    const data = (await res.json()) as {
      messages?: Array<{ id: string; threadId: string }>;
      nextPageToken?: string;
    };

    return {
      ids: (data.messages ?? []).map((m) => ({ messageId: m.id, threadId: m.threadId })),
      nextPageToken: data.nextPageToken ?? null,
      refreshed,
    };
  }

  async getMessage(
    creds: MailCredentials,
    messageId: string,
  ): Promise<{ message: FetchedMessage; refreshed?: RefreshedCredentials }> {
    const { accessToken, refreshed } = await this.ensureToken(creds);
    const res = await this.call(accessToken, `/messages/${messageId}?format=full`);
    return { message: toFetchedMessage((await res.json()) as GmailMessage), refreshed };
  }

  async sendReply(
    creds: MailCredentials,
    input: {
      providerThreadId: string;
      to: string[];
      cc?: string[];
      subject: string;
      bodyText: string;
      bodyHtml?: string;
      inReplyToMessageId?: string;
    },
  ): Promise<{ providerMessageId: string; refreshed?: RefreshedCredentials }> {
    const { accessToken, refreshed } = await this.ensureToken(creds);

    const raw = encodeMime(buildReplyMime(input));

    const res = await this.call(accessToken, "/messages/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ raw, threadId: input.providerThreadId }),
    });
    const data = (await res.json()) as { id: string };
    return { providerMessageId: data.id, refreshed };
  }

  /**
   * Send an already-built message (playbook-v6 F5): a new conversation, or a
   * follow-up in an existing thread. The caller builds the MIME — the cold
   * outbound sender asserts its own from-address before it gets here.
   */
  async sendRaw(
    creds: MailCredentials,
    input: { mime: string; threadId?: string | null },
  ): Promise<{ providerMessageId: string; providerThreadId: string; refreshed?: RefreshedCredentials }> {
    const { accessToken, refreshed } = await this.ensureToken(creds);
    const res = await this.call(accessToken, "/messages/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ raw: encodeMime(input.mime), ...(input.threadId ? { threadId: input.threadId } : {}) }),
    });
    const data = (await res.json()) as { id: string; threadId: string };
    return { providerMessageId: data.id, providerThreadId: data.threadId, refreshed };
  }

  /**
   * The account's signature for a send-as address. Gmail adds it in its own
   * client but NOT to mail sent through the API, so a sender that wants its
   * mail to look hand-written has to fetch it and append it. HTML as Gmail
   * stores it; null when the account has none.
   */
  async getSendAsSignature(
    creds: MailCredentials,
    sendAsEmail: string,
  ): Promise<{ signatureHtml: string | null; refreshed?: RefreshedCredentials }> {
    const { accessToken, refreshed } = await this.ensureToken(creds);
    const res = await this.call(accessToken, `/settings/sendAs/${encodeURIComponent(sendAsEmail)}`);
    const data = (await res.json()) as { signature?: string };
    return { signatureHtml: data.signature?.trim() ? data.signature : null, refreshed };
  }

  /** The RFC 5322 Message-ID of a sent message, so a follow-up threads for the recipient too. */
  async getMessageIdHeader(
    creds: MailCredentials,
    messageId: string,
  ): Promise<{ messageIdHeader: string | null; refreshed?: RefreshedCredentials }> {
    const { accessToken, refreshed } = await this.ensureToken(creds);
    const res = await this.call(accessToken, `/messages/${messageId}?format=metadata&metadataHeaders=Message-ID`);
    const data = (await res.json()) as GmailMessage;
    const h = data.payload?.headers?.find((x) => x.name.toLowerCase() === "message-id");
    return { messageIdHeader: h?.value ?? null, refreshed };
  }
}
