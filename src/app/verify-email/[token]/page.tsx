import { confirmEmailChangeToken } from "@/modules/members/email-change";

/**
 * Confirm a changed sign-in address (§4). Deliberately unauthenticated.
 *
 * The token is the credential, on the same terms as an invitation or a
 * password reset. It is consumed by LOADING the page rather than by a button,
 * because the person clicking it has just come from their own inbox and a
 * second confirmation step teaches nothing — the click WAS the confirmation.
 *
 * A cancelled link and one nobody issued give the same answer, for the same
 * reason a revoked invitation does.
 */
export const dynamic = "force-dynamic";

export default async function VerifyEmailPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const res = await confirmEmailChangeToken(token);

  return (
    <main className="grid min-h-screen place-items-center px-5 py-10">
      <div className="w-full max-w-[400px] text-center">
        <h1 className="font-display text-xl font-bold lowercase tracking-display">
          {res.ok ? "address confirmed" : "link not valid"}
        </h1>
        <div className="mt-4 rounded-card border border-line bg-panel p-5">
          {res.ok ? (
            <>
              <p className="text-[13px] leading-relaxed text-ink" data-testid="verify-ok">
                Your sign-in address is now <b>{res.email}</b>.
              </p>
              <p className="mt-2 text-[12px] leading-relaxed text-muted">
                You have been signed out everywhere — sign in again with the new
                address.
              </p>
            </>
          ) : (
            <p className="text-[13px] text-[#FFB3C2]" data-testid="verify-error">
              {res.error}
            </p>
          )}
          <a
            href="/login"
            className="mt-3 inline-block text-[12.5px] text-accent-ink underline"
          >
            Go to sign in
          </a>
        </div>
      </div>
    </main>
  );
}
