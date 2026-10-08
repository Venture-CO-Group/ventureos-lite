/**
 * Mail provider interface (playbook-v2 P2b).
 *
 * Gmail is the first implementation; the interface exists so IMAP can be the
 * second without anything above it changing. That is not speculative — it is
 * the fallback if the OAuth consent screen ever moves from Internal to
 * External, where Gmail's restricted scopes need Google verification.
 *
 * Note what the interface does NOT expose: there is no "list everything" and no
 * "get mailbox". A caller can only ask for messages matching a query it built
 * from CRM data, which keeps the privacy boundary at the type level rather than
 * in a comment.
 */
export interface MailCredentials {
  accessToken: string;
  refreshToken: string | null;
  expiryDate: Date | null;
  /** The OAuth client that issued these tokens; a refresh must use it. */
  clientRef?: string | null;
}

/** Credentials the provider refreshed mid-call, for the caller to persist. */
export type RefreshedCredentials = Partial<MailCredentials>;

export interface MailHeaders {
  from: string;
  to: string[];
  cc: string[];
  subject: string | null;
  date: Date;
}

export interface MailAttachmentMeta {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  providerAttachmentId: string;
}

export interface FetchedMessage {
  providerMessageId: string;
  providerThreadId: string;
  headers: MailHeaders;
  snippet: string;
  /** Raw HTML as the provider returned it. Sanitized by the ingest layer. */
  bodyHtml: string | null;
  bodyText: string | null;
  attachments: MailAttachmentMeta[];
  unread: boolean;
}

export interface MessagePage {
  ids: Array<{ messageId: string; threadId: string }>;
  nextPageToken: string | null;
  refreshed?: RefreshedCredentials;
}

export interface MailProvider {
  readonly name: string;

  /**
   * Message ids matching a query the CALLER built. The provider never
   * constructs a query itself — that is the whole point of the boundary.
   */
  listMessageIds(
    creds: MailCredentials,
    query: string,
    pageToken?: string,
  ): Promise<MessagePage>;

  getMessage(
    creds: MailCredentials,
    messageId: string,
  ): Promise<{ message: FetchedMessage; refreshed?: RefreshedCredentials }>;

  /** Reply on an existing thread, as the mailbox owner. */
  sendReply(
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
  ): Promise<{ providerMessageId: string; refreshed?: RefreshedCredentials }>;
}

/** Raised when the mailbox needs reconnecting rather than retrying. */
export class MailAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailAuthError";
  }
}

/** Raised when the provider asked us to slow down. Retried with backoff. */
export class MailRateLimitError extends Error {
  constructor(
    message: string,
    /** Seconds the provider suggested waiting, when it said. */
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = "MailRateLimitError";
  }
}
