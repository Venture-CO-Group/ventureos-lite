import { beginAccept } from "@/modules/members/accept";
import { AcceptInviteForm } from "@/components/accept-invite-form";

/**
 * Accepting an invitation (§2). Deliberately unauthenticated.
 *
 * The token IS the credential — 256 bits, hashed at rest, single-use, seven
 * days — which is the same contract the password-reset page runs under.
 *
 * Unlike the other pre-authentication screens it carries the WORKSPACE's
 * wordmark rather than the product's, because the invitation names the
 * workspace — somebody invited to a white-labelled installation should see the
 * company that invited them. There is nothing to show before the token
 * resolves, so a refusal shows no mark at all.
 *
 * A revoked link and a link nobody ever issued produce the SAME message, and
 * that is the whole reason `acceptVerdict` exists: "this invitation was
 * withdrawn" would tell whoever holds it that the address is a real account
 * here and that somebody changed their mind about them. An expired link is
 * told the truth, because that is a real person who clicked a day late and a
 * generic refusal would send them to support instead of asking for a new one.
 */
export const dynamic = "force-dynamic";

export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const result = await beginAccept(token);

  return (
    <main className="grid min-h-screen place-items-center px-5 py-10">
      <div className="w-full max-w-[420px]">
        <div className="mb-6 text-center">
          {result.ok && (
            <>
              <div className="font-display text-[26px] tracking-display">
                <b className="font-extrabold">{result.state.markBold}</b>
                {result.state.markLight && (
                  <span className="ml-1.5 font-light text-muted">
                    {result.state.markLight}
                  </span>
                )}
              </div>
              <h1 className="mt-3 font-display text-xl font-bold lowercase tracking-display">
                join {result.state.workspaceName.toLowerCase()}
              </h1>
              <p className="mt-1.5 text-[12.5px] text-muted">{result.state.email}</p>
            </>
          )}
          {!result.ok && (
            <h1 className="font-display text-xl font-bold lowercase tracking-display">
              invitation
            </h1>
          )}
        </div>

        {result.ok ? (
          <AcceptInviteForm token={token} state={result.state} />
        ) : (
          <div className="rounded-card border border-line bg-panel p-5 text-center">
            <p className="text-[13px] text-[#FFB3C2]" data-testid="invite-invalid">
              {result.message}
            </p>
            <p className="mt-2 text-[12px] leading-relaxed text-muted">
              {result.canResend
                ? "Ask whoever invited you to send a new one — it takes them a click."
                : "If you think this is a mistake, ask whoever invited you."}
            </p>
            <a
              href="/login"
              className="mt-3 inline-block text-[12.5px] text-accent-ink underline"
            >
              Sign in instead
            </a>
          </div>
        )}
      </div>
    </main>
  );
}
