"use client";

import { useState, useTransition } from "react";
import { attempt } from "@/lib/client/server-action";
import { setFinderThirdPartySharing } from "@/modules/finder/actions";

/** The workspace's third-party sharing setting (item 7). Owner-editable; everyone else sees it. */
export function FinderSharingSetting({ allowed, canEdit }: { allowed: boolean; canEdit: boolean }) {
  const [value, setValue] = useState(allowed);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <section className="mb-4 grid gap-1 rounded-card border border-line bg-panel p-3" data-testid="finder-sharing-setting">
      <label className="flex min-h-[44px] items-start gap-2 text-[12.5px]">
        <input
          type="checkbox"
          className="mt-1"
          checked={value}
          disabled={!canEdit || pending}
          onChange={(e) => {
            const next = e.target.checked;
            setError(null);
            startTransition(async () => {
              const res = await attempt(setFinderThirdPartySharing(next));
              if (res.ok) setValue(next);
              else setError(res.error);
            });
          }}
        />
        <span>
          <b>Exported company data may be passed to third parties</b> — off by default. The data provider&apos;s licence may
          restrict redistribution; this setting is shown on every export dialog.{" "}
          {!canEdit && <span className="text-muted">Only an Owner can change it.</span>}
        </span>
      </label>
      {error && <p className="text-[12px] text-[#FFB3C2]">{error}</p>}
    </section>
  );
}
