"use client";
import { serverActionError } from "@/lib/client/server-action";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  captureProfileViaExtension,
  extensionReadiness,
  requestLinkedInPermission,
  type ExtensionReadiness,
} from "@/lib/extension-bridge";
import type { LeadCard } from "@/lib/ai/prompts/lead-research";
import {
  captureLinkedin,
  runResearch,
  createLeadManual,
  moveLeadStage,
} from "@/modules/leads/actions";
import { listReferrers, type ReferrerOption } from "@/modules/referrals/actions";
import { CsvImport } from "./csv-import";
import { preParse, hasAnalyzableText } from "@/modules/leads/preparse";
import { ManualLeadForm } from "./manual-lead-form";
import { OverrideDialog } from "./lead-dialogs";

// ---- small bits -----------------------------------------------------------

function Notches({ score }: { score: number | null }) {
  const n = score ?? 0;
  return (
    <span className="inline-flex gap-[3px] align-middle">
      {Array.from({ length: 5 }).map((_, i) => (
        <i
          key={i}
          className={`h-[5px] w-[9px] rounded-[2px] ${i < n ? "bg-grad" : "bg-line"}`}
        />
      ))}
    </span>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="mr-1 mb-1 inline-flex items-center rounded-full border border-accent-soft px-2 py-0.5 text-[11px] font-semibold text-accent-ink">
      {children}
    </span>
  );
}

// ---- Claude rail (reveal animation like the prototype) --------------------

type RailState =
  | { status: "idle" }
  | { status: "streaming" }
  | { status: "done"; card: LeadCard; icpScore: number; leadId: string };

function ClaudeRail({
  state,
  threshold,
  onOverride,
  onAddToPipeline,
}: {
  state: RailState;
  threshold: number;
  onOverride: (leadId: string) => void;
  onAddToPipeline: (leadId: string) => void;
}) {
  const total = 6;
  const [revealed, setRevealed] = useState(0);

  useEffect(() => {
    if (state.status !== "done") {
      setRevealed(0);
      return;
    }
    setRevealed(0);
    const iv = setInterval(() => {
      setRevealed((r) => {
        if (r >= total) {
          clearInterval(iv);
          return r;
        }
        return r + 1;
      });
    }, 500);
    return () => clearInterval(iv);
  }, [state]);

  return (
    <div className="sticky top-0">
      <div className="rounded-card border-[1.5px] border-transparent bg-[linear-gradient(rgba(3,7,32,0.95),rgba(3,7,32,0.95))_padding-box,linear-gradient(135deg,#310B59,#7427C6)_border-box] p-[18px] shadow-glow-lg">
        <div className="mb-3.5 flex items-center gap-2">
          <div className="grid h-[22px] w-[22px] place-items-center rounded-[7px] bg-grad text-[12px]">
            ✦
          </div>
          <b className="text-[13px]">Claude · Lead card</b>
          <span className="ml-auto text-[11px] text-muted">
            {state.status === "streaming" ? (
              <span className="inline-flex gap-[3px]">
                <i className="h-1 w-1 animate-pulse rounded-full bg-accent-ink" />
                <i className="h-1 w-1 animate-pulse rounded-full bg-accent-ink [animation-delay:0.2s]" />
                <i className="h-1 w-1 animate-pulse rounded-full bg-accent-ink [animation-delay:0.4s]" />
              </span>
            ) : state.status === "done" ? (
              "done"
            ) : (
              "idle"
            )}
          </span>
        </div>

        {state.status === "idle" && (
          <p className="text-[12.5px] text-muted">
            Paste a profile and run research — the structured lead card streams in
            here. Every score can be overridden; overrides are logged.
          </p>
        )}
        {state.status === "streaming" && (
          <p className="text-[12.5px] text-muted">Researching… nothing is sent anywhere.</p>
        )}

        {state.status === "done" && (
          <div className="space-y-0">
            <Section show={revealed >= 1} title="Company">
              <p className="text-[12.5px] leading-relaxed text-[#C9CEE3]">
                <b>{state.card.company.name}</b>
                {state.card.company.industry ? ` · ${state.card.company.industry}` : ""}
                {state.card.company.sizeEmployees
                  ? ` · ~${state.card.company.sizeEmployees} employees`
                  : ""}
                . {state.card.company.summary}
              </p>
            </Section>
            <Section show={revealed >= 2} title="Person">
              <p className="text-[12.5px] leading-relaxed text-[#C9CEE3]">
                <b>{state.card.person.name}</b>
                {state.card.person.title ? `, ${state.card.person.title}` : ""}.{" "}
                {state.card.person.summary}
              </p>
            </Section>
            <Section show={revealed >= 3} title="Trigger signals">
              <div>
                {state.card.signals.map((s, i) => (
                  <Tag key={i}>{s}</Tag>
                ))}
              </div>
            </Section>
            <Section show={revealed >= 4} title="Likely pain points">
              <ol className="list-decimal pl-4 text-[12.5px] leading-relaxed text-[#C9CEE3]">
                {state.card.pains.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ol>
            </Section>
            <Section show={revealed >= 5} title="Suggested hook">
              <div className="rounded-[10px] bg-accent-soft px-3 py-2.5 text-[12.5px] italic leading-relaxed text-[#E4D3FF]">
                {state.card.hook}
              </div>
            </Section>
            <Section show={revealed >= 6} title="ICP score">
              <div className="flex items-center justify-between border-t border-line pt-2 text-[12.5px]">
                <span>
                  <b>Total</b>
                </span>
                <span className="flex items-center gap-2">
                  <Notches score={state.icpScore} />
                  <b>{state.icpScore}</b>
                </span>
              </div>
              <p className="mt-1 text-[11px] text-muted">
                {state.icpScore >= threshold
                  ? "Above the score gate — can be contacted."
                  : `Below the gate (${threshold}) — cannot enter Contacted.`}
              </p>
              <div className="mt-3.5 flex gap-2">
                <button
                  onClick={() => onAddToPipeline(state.leadId)}
                  className="flex-1 rounded-[10px] border-[1.5px] border-transparent bg-canvas px-3 py-2 text-[12px] font-semibold text-ink shadow-glow [background-clip:padding-box,border-box] [background-image:linear-gradient(#00051D,#00051D),linear-gradient(135deg,#310B59,#7427C6)] [background-origin:border-box]"
                >
                  Add to pipeline
                </button>
                <button
                  onClick={() => onOverride(state.leadId)}
                  className="rounded-[10px] border border-line bg-panel px-3 py-2 text-[12px] font-semibold text-ink hover:bg-panel-2"
                >
                  Override score
                </button>
              </div>
            </Section>
          </div>
        )}
      </div>
    </div>
  );
}

function Section({
  show,
  title,
  children,
}: {
  show: boolean;
  title: string;
  children: React.ReactNode;
}) {
  if (!show) return null;
  return (
    <section className="animate-[fade_0.25s_ease] border-t border-line py-3 first:border-t-0">
      <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">
        {title}
      </h4>
      {children}
    </section>
  );
}

// ---- main -----------------------------------------------------------------

export function LeadEngine({
  threshold,
  table,
}: {
  threshold: number;
  /**
   * The leads table, rendered by the server so it can filter, sort and
   * paginate (playbook-v2 P3/2). Passed in as a slot rather than owned here:
   * capture and the Claude rail are about ONE lead, the table is about all of
   * them, and merging the two meant every filter change re-rendered the
   * capture box and the rail's reveal animation with it.
   */
  table: React.ReactNode;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [rail, setRail] = useState<RailState>({ status: "idle" });
  const [paste, setPaste] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [showManual, setShowManual] = useState(false);
  // The extension is optional, so its actions only appear when it answers.
  // Four distinct states, because each needs a different button (see
  // ExtensionReadiness). One boolean is what made a missing LinkedIn
  // permission indistinguishable from a missing extension.
  const [readiness, setReadiness] = useState<ExtensionReadiness | null>(null);
  const [permMsg, setPermMsg] = useState<string | null>(null);
  const [extBusy, setExtBusy] = useState(false);
  const [extNote, setExtNote] = useState<string | null>(null);

  useEffect(() => {
    // Optional tool: ask once, show its actions only if it answers. A missing
    // extension simply never replies, so this resolves to false on its own.
    let active = true;
    extensionReadiness().then((r) => {
      if (active) setReadiness(r);
    });
    return () => {
      active = false;
    };
  }, []);
  // P1/1a — the same pure check the server uses, so the UI never offers a
  // research call that would be refused. P1/1b — what we already know from the
  // paste without spending anything.
  const parsed = useMemo(() => preParse(paste), [paste]);
  const hasText = useMemo(() => hasAnalyzableText(paste), [paste]);
  // The first LinkedIn profile URL in the pasted text — what the extension
  // would be asked to read.
  const linkedInUrl = (() => {
    const match = /https?:\/\/(?:[a-z-]+\.)?linkedin\.com\/in\/[^\s]+/i.exec(paste);
    return match ? match[0].split("?")[0]!.replace(/\/$/, "") : null;
  })();

  // A bare profile URL IS enough when the extension is here to read the page —
  // it is the whole reason the extension exists. Previously the button stayed
  // disabled in exactly that case, so the only way to research anything was to
  // paste the profile text by hand, and the extension's own captures could not
  // be researched at all.
  const hasExtension = readiness !== null && readiness.state !== "not_installed";
  // Only a READY extension can actually read a page. The other states are
  // reachable problems, each with its own action below.
  const canReadWithExtension = readiness?.state === "ready" && !!linkedInUrl;
  const canResearch = hasText || canReadWithExtension;

  const urlOnly = paste.trim().length > 0 && !hasText;
  const [showCsv, setShowCsv] = useState(false);
  const [overrideFor, setOverrideFor] = useState<string | null>(null);

  function firstUrl(text: string): string {
    const m = text.match(/https?:\/\/\S+/);
    return m ? m[0] : "";
  }

  async function research(leadId: string) {
    setError(null);
    setRail({ status: "streaming" });
    try {
      const res = await runResearch(leadId);
      if (!res.ok) {
        setRail({ status: "idle" });
        setError(res.error);
        return;
      }
      setRail({ status: "done", card: res.card, icpScore: res.icpScore, leadId });
      router.refresh();
    } catch (e) {
      setRail({ status: "idle" });
      setError(serverActionError(e));
    }
  }

  async function captureWithExtension() {
    if (!linkedInUrl) return;
    setExtBusy(true);
    setExtNote(null);
    try {
      const res = await captureProfileViaExtension(linkedInUrl);
      if (!res.ok) {
        setExtNote(res.message);
        return;
      }
      // Say what was actually read: a capture that got only a URL used to look
      // exactly like a good one, which is how "unknown lead, no data" happened
      // without anybody noticing.
      // Each field is named with the layer that supplied it: when a field stops
      // arriving, the layer behind it is what broke, and this is where that is
      // visible without opening the extension.
      const detail = res.read.map((f) => `${f} (${res.readFrom[f] ?? "?"})`).join(", ");
      const photo = res.avatarProblem ? ` Photo not saved: ${res.avatarProblem}.` : "";
      setExtNote(
        res.read.length === 0
          ? "Read the URL only — LinkedIn's layout has changed."
          : `${res.created ? "Captured" : "Updated"} · read ${detail}.${photo}`,
      );
      router.refresh();
    } finally {
      setExtBusy(false);
    }
  }

  async function researchFromPaste() {
    if (!paste.trim()) return;
    setError(null);
    setRail({ status: "streaming" });
    try {
      // A bare profile URL: let the extension read the page first, then
      // research what it captured. One button, one press — which is what a
      // person means by "research this profile".
      if (!hasText && canReadWithExtension && linkedInUrl) {
        const res = await captureProfileViaExtension(linkedInUrl);
        if (!res.ok || !res.leadId) {
          setRail({ status: "idle" });
          setError(res.ok ? "The capture did not come back with a lead." : res.message);
          return;
        }
        const read = await runResearch(res.leadId);
        if (!read.ok) {
          setRail({ status: "idle" });
          // The lead WAS captured — only the analysis did not run, so say so
          // rather than implying the capture failed.
          setError(`${read.error} The lead was saved.`);
          router.refresh();
          return;
        }
        setRail({ status: "done", card: read.card, icpScore: read.icpScore, leadId: res.leadId });
        setPaste("");
        router.refresh();
        return;
      }

      const { leadId } = await captureLinkedin({
        url: firstUrl(paste) || paste.slice(0, 120),
        pageText: paste,
      });
      const done = await runResearch(leadId);
      if (!done.ok) {
        setRail({ status: "idle" });
        setError(`${done.error} The lead was saved.`);
        setPaste("");
        router.refresh();
        return;
      }
      setRail({ status: "done", card: done.card, icpScore: done.icpScore, leadId });
      setPaste("");
      router.refresh();
    } catch (e) {
      setRail({ status: "idle" });
      setError(serverActionError(e));
    }
  }

  async function toContacted(leadId: string) {
    setError(null);
    const res = await moveLeadStage(leadId, "CONTACTED");
    if (!res.ok) setError(res.error);
    else router.refresh();
  }

  return (
    <div className="max-w-[1400px]">
      {error && (
        <div className="mb-3 rounded-[10px] border border-[rgba(255,92,122,0.35)] bg-[rgba(255,92,122,0.1)] px-3.5 py-2.5 text-[12.5px] text-[#FFB3C2]">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 items-start gap-[18px] lg:grid-cols-[1fr_340px]">
        <div>
          {/* capture */}
          <div className="mb-4 rounded-card border border-line bg-panel p-[18px]">
            <div className="mb-2.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
              Capture a lead
            </div>
            <textarea
              value={paste}
              onChange={(e) => setPaste(e.target.value)}
              placeholder="Paste a LinkedIn profile URL and the page text — or capture it with the browser extension while viewing the profile."
              className="min-h-[84px] w-full resize-y rounded-[10px] border border-line bg-[rgba(0,5,29,0.5)] p-3 text-[13px] text-ink outline-none placeholder:text-muted focus:border-accent"
            />
            {urlOnly && (
              <div
                data-testid="research-guidance"
                className="mt-2.5 rounded-[10px] border border-[rgba(245,184,65,0.35)] bg-[rgba(245,184,65,0.08)] px-3.5 py-2.5 text-[12.5px] text-warn"
              >
                {canReadWithExtension ? (
                  <>
                    Only a URL so far — <b>Research with Claude</b> will read
                    the page with the extension first, or you can read it now
                    without researching.
                  </>
                ) : (
                  <>
                    Paste the profile <b>text</b> alongside the URL, or let the
                    extension read the page — there is nothing to analyse yet.
                  </>
                )}
                {linkedInUrl && readiness && (
                  <div className="mt-2" data-testid="extension-action">
                    {/* One button per state. The point of the four states is that
                        "it did not work" is never the whole answer — each of these
                        has a different next action, and the LinkedIn permission
                        one used to have none at all. */}
                    {readiness.state === "not_installed" && (
                      <>
                        <a
                          href="/settings/extension"
                          data-testid="extension-install"
                          className="rounded-[10px] border border-line bg-panel px-3 py-1.5 text-[12.5px] font-semibold text-ink hover:bg-panel-2"
                        >
                          Install the capture extension
                        </a>
                        <span className="ml-2 text-[12px] text-muted">
                          Not installed in this browser.
                        </span>
                      </>
                    )}

                    {readiness.state === "not_configured" && (
                      <>
                        <a
                          href="/settings/extension"
                          data-testid="extension-configure"
                          className="rounded-[10px] border border-line bg-panel px-3 py-1.5 text-[12.5px] font-semibold text-ink hover:bg-panel-2"
                        >
                          Connect the extension
                        </a>
                        <span className="ml-2 text-[12px] text-muted">
                          Installed (v{readiness.version}), but it has no address or token yet.
                        </span>
                      </>
                    )}

                    {readiness.state === "needs_linkedin_permission" && (
                      <>
                        <button
                          onClick={async () => {
                            // Cannot grant it here: Chrome only honours
                            // permissions.request() from a click INSIDE the
                            // extension, so this opens the extension's own page.
                            const r = await requestLinkedInPermission();
                            setPermMsg(
                              r.ok
                                ? r.alreadyGranted
                                  ? "Already allowed — press Research again."
                                  : "Opened the extension's permission tab. Allow it there, then come back."
                                : r.message,
                            );
                            setReadiness(await extensionReadiness());
                          }}
                          data-testid="extension-grant-linkedin"
                          className="rounded-[10px] border border-line bg-panel px-3 py-1.5 text-[12.5px] font-semibold text-ink hover:bg-panel-2"
                        >
                          Allow LinkedIn access
                        </button>
                        <span className="ml-2 text-[12px] text-muted">
                          {permMsg ?? "Installed, but not yet allowed to read LinkedIn pages."}
                        </span>
                      </>
                    )}

                    {readiness.state === "ready" && (
                      <>
                        <button
                          onClick={captureWithExtension}
                          disabled={extBusy}
                          data-testid="capture-with-extension"
                          className="rounded-[10px] border border-line bg-panel px-3 py-1.5 text-[12.5px] font-semibold text-ink hover:bg-panel-2 disabled:opacity-60"
                        >
                          {extBusy ? "Reading the profile…" : "Read it with the extension"}
                        </button>
                        {extNote && <span className="ml-2 text-[12px]">{extNote}</span>}
                      </>
                    )}
                  </div>
                )}
                {parsed.websites[0] && (
                  <>
                    {" "}
                    <a
                      href={
                        /^https?:\/\//i.test(paste.trim().split(/\s+/)[0] ?? "")
                          ? paste.trim().split(/\s+/)[0]
                          : `https://${parsed.websites[0]}`
                      }
                      target="_blank"
                      rel="noreferrer"
                      className="underline hover:text-ink"
                    >
                      Open profile ↗
                    </a>
                  </>
                )}
              </div>
            )}

            {(parsed.emails[0] || parsed.phones[0] || parsed.city || parsed.domain) && (
              <div
                data-testid="preparse-chips"
                className="mt-2.5 flex flex-wrap gap-1.5 text-[11.5px]"
              >
                <span className="text-muted">Found without AI:</span>
                {[parsed.emails[0], parsed.phones[0], parsed.domain, parsed.city]
                  .filter(Boolean)
                  .map((v) => (
                    <span
                      key={v as string}
                      className="rounded-full border border-line bg-panel-2 px-2 py-0.5 text-[#C9CEE3]"
                    >
                      {v}
                    </span>
                  ))}
              </div>
            )}

            <div className="mt-3 flex flex-wrap items-center gap-2.5">
              <button
                onClick={() => startTransition(researchFromPaste)}
                title={
                  canResearch
                    ? canReadWithExtension && !hasText
                      ? "Reads the profile with the extension, then researches it"
                      : undefined
                    : "Needs profile text, not just a URL"
                }
                data-testid="research-button"
                disabled={pending || rail.status === "streaming" || !canResearch}
                className="rounded-[10px] border-[1.5px] border-transparent bg-canvas px-4 py-2 text-[13px] font-semibold text-ink shadow-glow [background-clip:padding-box,border-box] [background-image:linear-gradient(#00051D,#00051D),linear-gradient(135deg,#310B59,#7427C6)] [background-origin:border-box] disabled:opacity-60"
              >
                ✦ Research with Claude
              </button>
              <button
                onClick={() => setShowManual(true)}
                className="rounded-[10px] border border-line bg-panel px-4 py-2 text-[13px] font-semibold text-ink hover:bg-panel-2"
              >
                Add manually
              </button>
              <button
                onClick={() => setShowCsv(true)}
                className="rounded-[10px] border border-line bg-panel px-4 py-2 text-[13px] font-semibold text-ink hover:bg-panel-2"
              >
                Import CSV
              </button>
              <span className="ml-auto text-[12px] text-muted">
                Research runs take ~10s · nothing is sent anywhere
              </span>
            </div>
          </div>

          {/* table — server-rendered: filtering, sorting and paging all
              happen there (playbook-v2 P3/2). */}
          {table}
        </div>

        <ClaudeRail
          state={rail}
          threshold={threshold}
          onOverride={(id) => setOverrideFor(id)}
          onAddToPipeline={(id) => startTransition(() => toContacted(id))}
        />
      </div>

      {showManual && (
        <ManualLeadForm
          onClose={() => setShowManual(false)}
          onDone={() => {
            setShowManual(false);
            router.refresh();
          }}
        />
      )}
      {showCsv && (
        <CsvImport
          onClose={() => setShowCsv(false)}
          onDone={() => {
            setShowCsv(false);
            router.refresh();
          }}
        />
      )}
      {overrideFor && (
        <OverrideDialog
          leadId={overrideFor}
          onClose={() => setOverrideFor(null)}
          onDone={() => {
            setOverrideFor(null);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}
