import { GOOGLE_PAGE_ERRORS, googleErrorMessage } from "@/modules/google/errors";

/**
 * What a Google OAuth failure means, in our words (per-workspace clients, item 4).
 *
 * `GoogleErrorBanner` shows the mapped sentence for a failure that came back to
 * us. `GoogleConnectHelp` covers the ones that never come back — Google shows
 * them on its own page — by explaining them before the person leaves.
 */
export function GoogleErrorBanner({ code }: { code: string | null | undefined }) {
  if (!code) return null;
  const { message } = googleErrorMessage(code);
  return (
    <p
      role="alert"
      data-testid="google-error"
      className="rounded-[8px] border border-[rgba(255,92,122,0.35)] bg-[rgba(255,92,122,0.08)] px-3 py-2 text-[12.5px] leading-relaxed text-[#FFB3C2]"
    >
      {message}
    </p>
  );
}

export function GoogleConnectHelp() {
  return (
    <details className="mt-2 text-[11.5px] text-muted" data-testid="google-connect-help">
      <summary className="cursor-pointer">If Google shows an error page</summary>
      <ul className="mt-1.5 grid gap-1.5 leading-relaxed">
        {GOOGLE_PAGE_ERRORS.map((e) => (
          <li key={e.code}>
            <code className="text-ink">{e.code}</code> — {e.message}
          </li>
        ))}
      </ul>
    </details>
  );
}
