import { redirect } from "next/navigation";
import { EnrollTotp } from "@/components/enroll-totp";
import { getSecurityStatus } from "@/modules/auth/actions";
import { tryGetActiveContext } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * Forced 2FA enrolment, for either of two reasons.
 *
 * An Owner reset THIS person's second factor — the old secret is gone — or the
 * WORKSPACE now requires one from everybody (P5/5.1). The two call for
 * different next actions, so the page says which applies rather than offering
 * one explanation that is wrong half the time.
 */
export default async function EnrollTwoFactorPage({
  searchParams,
}: {
  searchParams: Promise<{ why?: string }>;
}) {
  if (!(await tryGetActiveContext())) redirect("/login");
  const { why } = await searchParams;
  const status = await getSecurityStatus();
  const byPolicy = why === "workspace_policy";
  // Nothing to do — don't strand anyone on a dead-end screen. A policy
  // enrolment is satisfied by having an authenticator at all.
  if (status.totpEnabled) redirect("/");
  if (!status.mustEnrollTotp && !byPolicy) redirect("/");

  return (
    <main className="grid min-h-screen place-items-center px-5 py-10">
      <div className="w-full max-w-[420px]">
        <div className="mb-6 text-center">
          <div className="font-display text-[26px] tracking-display">
            <b className="font-extrabold">venture</b>
            <span className="ml-1.5 font-light text-muted">os</span>
          </div>
          <h1 className="mt-3 font-display text-xl font-bold lowercase tracking-display">
            set up two-factor authentication
          </h1>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted">
            {byPolicy && !status.mustEnrollTotp
              ? `This workspace requires two-factor authentication. Register an authenticator for ${status.email} to continue — nothing else is reachable until you do.`
              : `An Owner reset the second factor on ${status.email}. Register a new authenticator to continue.`}
          </p>
        </div>
        <EnrollTotp />
      </div>
    </main>
  );
}
