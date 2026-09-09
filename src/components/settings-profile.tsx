"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { attempt, serverActionError } from "@/lib/client/server-action";
import {
  removeMyAvatar,
  setMyDensity,
  updateMyProfile,
  type MyProfile,
} from "@/modules/users/profile";
import { DENSITIES, DENSITY_HELP, DENSITY_LABEL } from "@/lib/density";
import { initialsOf } from "@/lib/initials";

const CARD = "rounded-card border border-line bg-panel p-4";
const LABEL = "text-[10px] font-semibold uppercase tracking-[0.14em] text-muted";
const INPUT =
  "min-h-[40px] rounded-[9px] border border-line bg-[rgba(0,5,29,0.5)] px-3 py-2 text-[13px] text-ink outline-none focus:border-accent";
const BTN =
  "min-h-[36px] rounded-[8px] border border-line px-3 py-1.5 text-[12px] font-semibold text-ink transition-colors hover:border-accent disabled:opacity-45";

/**
 * Your own profile — the first panel of the Settings page, which is now about
 * YOU rather than about the software.
 *
 * The photo is uploaded through a route rather than a Server Action, because the
 * body is a file and the 2 MB ceiling has to be enforceable before the bytes are
 * read into memory.
 */
export function SettingsProfile({ profile }: { profile: MyProfile }) {
  const router = useRouter();
  const [name, setName] = useState(profile.name);
  const [avatarUrl, setAvatarUrl] = useState(profile.avatarUrl);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [pending, startTransition] = useTransition();
  const [density, setDensity] = useState(profile.density);
  const [savingDensity, setSavingDensity] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);

  async function upload(file: File) {
    setMsg(null);
    setUploading(true);
    try {
      const res = await fetch("/api/me/avatar", {
        method: "POST",
        headers: { "content-type": file.type || "application/octet-stream" },
        body: file,
      });
      const body = (await res.json()) as { ok: boolean; error?: string; url?: string };
      if (!body.ok) {
        setMsg({ kind: "err", text: body.error ?? "Could not store the image." });
        return;
      }
      setAvatarUrl(body.url ?? null);
      setMsg({ kind: "ok", text: "Photo updated." });
      router.refresh();
    } catch (e) {
      setMsg({ kind: "err", text: serverActionError(e) });
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  return (
    <section className={CARD} data-testid="settings-profile">
      <div className="mb-3 flex items-baseline gap-2">
        <p className={LABEL}>Your profile</p>
        {profile.isSuperAdmin && (
          <span className="rounded-full border border-accent-soft bg-accent-soft px-2 py-0.5 text-[10px] font-semibold text-accent-ink">
            super admin
          </span>
        )}
      </div>

      <div className="flex flex-wrap items-start gap-4">
        {avatarUrl ? (
          /* eslint-disable-next-line @next/next/no-img-element -- served from an
             authenticated route, so next/image's optimiser cannot fetch it */
          <img
            src={avatarUrl}
            alt=""
            width={72}
            height={72}
            data-testid="profile-avatar"
            className="h-[72px] w-[72px] rounded-full border border-line object-cover"
          />
        ) : (
          <div
            data-testid="profile-avatar-empty"
            className="grid h-[72px] w-[72px] place-items-center rounded-full border border-line bg-panel-2 text-[20px] font-semibold text-muted"
          >
            {initialsOf(profile.name)}
          </div>
        )}

        <div className="grid gap-2">
          <div className="flex flex-wrap gap-2">
            <input
              ref={fileInput}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              data-testid="profile-avatar-input"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void upload(file);
              }}
            />
            <button
              type="button"
              className={BTN}
              disabled={uploading}
              data-testid="profile-avatar-pick"
              onClick={() => fileInput.current?.click()}
            >
              {uploading ? "Uploading…" : avatarUrl ? "Replace photo" : "Upload a photo"}
            </button>
            {avatarUrl && (
              <button
                type="button"
                className={BTN}
                disabled={pending}
                data-testid="profile-avatar-remove"
                onClick={() =>
                  startTransition(async () => {
                    await attempt(removeMyAvatar());
                    setAvatarUrl(null);
                    setMsg({ kind: "ok", text: "Photo removed." });
                    router.refresh();
                  })
                }
              >
                Remove
              </button>
            )}
          </div>
          <p className="text-[11px] text-muted">JPEG, PNG or WebP, up to 2 MB.</p>
        </div>
      </div>

      <div className="mt-4 grid gap-2 sm:max-w-[420px]">
        <label className="grid gap-1">
          <span className={LABEL}>Name</span>
          <input
            className={INPUT}
            value={name}
            data-testid="profile-name"
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="grid gap-1">
          <span className={LABEL}>Email</span>
          <input className={`${INPUT} opacity-60`} value={profile.email} readOnly />
          <span className="text-[11px] text-muted">
            Your sign-in address. An Owner changes it in Admin settings → Users.
          </span>
        </label>
        <div>
          <button
            type="button"
            className={BTN}
            data-testid="profile-save"
            disabled={pending || name.trim() === profile.name}
            onClick={() =>
              startTransition(async () => {
                setMsg(null);
                const res = await attempt(updateMyProfile({ name }));
                setMsg(
                  res.ok
                    ? { kind: "ok", text: "Saved." }
                    : { kind: "err", text: res.error },
                );
                router.refresh();
              })
            }
          >
            Save
          </button>
        </div>
      </div>

      {msg && (
        <p
          role="status"
          data-testid="profile-message"
          className={`mt-3 text-[12.5px] ${msg.kind === "ok" ? "text-pos" : "text-[#FFB3C2]"}`}
        >
          {msg.text}
        </p>
      )}

      {/**
       * Density (playbook-v5 P16/6).
       *
       * Here rather than in a "display" section of its own, because it is one
       * preference and a section with one control in it is a menu item nobody
       * finds. Saved on click — a radio pair does not need a Save button.
       *
       * The help text says compact is ignored on a phone. The RULE is that
       * 44px targets win, and it applies silently in the CSS; saying so once,
       * here, is different from interrupting somebody on a phone to explain
       * that their setting is being overridden.
       */}
      <div className="mt-4 border-t border-line pt-3">
        <p className={LABEL}>Row density</p>
        <div className="mt-1.5 flex flex-wrap gap-1.5" data-testid="density-toggle">
          {DENSITIES.map((d) => (
            <button
              key={d}
              type="button"
              data-testid={`density-${d}`}
              aria-pressed={density === d}
              disabled={savingDensity}
              onClick={() => {
                setDensity(d);
                setSavingDensity(true);
                startTransition(async () => {
                  const res = await setMyDensity(d);
                  setSavingDensity(false);
                  if (!res.ok) {
                    setDensity(profile.density);
                    setMsg({ kind: "err", text: res.error });
                    return;
                  }
                  // The shell stamps the attribute, so the whole app has to
                  // re-render — not just this panel.
                  router.refresh();
                });
              }}
              className={`rounded-[10px] border px-3 py-1.5 text-[12.5px] transition-colors disabled:opacity-60 ${
                density === d
                  ? "border-accent bg-accent-soft text-[#E4D3FF]"
                  : "border-line bg-panel text-muted hover:text-ink"
              }`}
            >
              {DENSITY_LABEL[d]}
            </button>
          ))}
        </div>
        <p className="mt-1.5 text-[11px] text-muted">{DENSITY_HELP[density]}</p>
      </div>

      <div className="mt-4 border-t border-line pt-3">
        <p className={LABEL}>Workspaces</p>
        <ul className="mt-1.5 grid gap-1">
          {profile.memberships.map((m) => (
            <li key={m.workspace} className="text-[12.5px] text-[#C9CEE3]">
              {m.workspace} · <span className="text-muted">{m.role.toLowerCase()}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
