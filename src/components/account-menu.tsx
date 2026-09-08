"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { signOutEverywhere } from "@/modules/auth/actions";

/**
 * Account menu in the top bar — the place a user reaches their own email,
 * password and 2FA (all of which live in Settings → security).
 */
export function AccountMenu({
  name,
  email,
  initials,
  avatarUrl = null,
  role,
  workspaceName,
}: {
  name: string;
  email: string;
  initials: string;
  /** Their uploaded photo. Initials on the gradient disc when there is none. */
  avatarUrl?: string | null;
  role: string;
  workspaceName: string;
}) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  const item =
    "flex min-h-[44px] w-full items-center gap-2 rounded-[9px] px-2.5 text-left text-[12.5px] text-ink hover:bg-panel-2";

  return (
    <div ref={boxRef} className="relative flex-none">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
        data-testid="account-menu-button"
        onClick={() => setOpen((v) => !v)}
        className={`grid h-[38px] w-[38px] place-items-center overflow-hidden rounded-full text-[13px] font-bold text-ink ring-offset-2 ring-offset-canvas focus-visible:ring-2 focus-visible:ring-accent ${
          avatarUrl ? "border border-line" : "bg-grad"
        }`}
      >
        {avatarUrl ? (
          /* eslint-disable-next-line @next/next/no-img-element -- authenticated route */
          <img
            src={avatarUrl}
            alt=""
            width={38}
            height={38}
            data-testid="account-menu-avatar"
            className="h-full w-full object-cover"
          />
        ) : (
          initials || "U"
        )}
      </button>

      {open && (
        <div
          role="menu"
          data-testid="account-menu"
          className="absolute right-0 top-[calc(100%+8px)] z-[70] w-[240px] rounded-[12px] border border-line bg-canvas p-1.5 shadow-glow-lg"
        >
          <div className="border-b border-line px-2.5 pb-2 pt-1.5">
            <b className="block truncate text-[13px] text-ink">{name}</b>
            <span className="block truncate text-[11.5px] text-muted">{email}</span>
            <span className="mt-0.5 block truncate text-[11px] text-muted">
              {role} · {workspaceName}
            </span>
          </div>
          <Link href="/settings/security" className={item} onClick={() => setOpen(false)} role="menuitem">
            Password &amp; two-factor
          </Link>
          <Link href="/settings" className={item} onClick={() => setOpen(false)} role="menuitem">
            Settings
          </Link>
          <form action={signOutEverywhere}>
            <button type="submit" className={item} role="menuitem" data-testid="account-signout">
              Sign out
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
