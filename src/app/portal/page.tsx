import { AppShell } from "@/components/app-shell";
import { getPortalView } from "@/modules/portal/actions";

/**
 * The client portal (P6/6.3).
 *
 * A client who can see their own delivery and their own documents — and
 * nothing else in the workspace — is what makes the delivery side sellable.
 * Today the only way a client learns where their build stands is an email
 * somebody remembers to send.
 *
 * Everything on this page is scoped by the company on the acting MEMBERSHIP.
 * There is no id in the URL, deliberately: a page with a company in its path is
 * a page somebody will try editing.
 */
export const dynamic = "force-dynamic";

const TYPE_LABEL: Record<string, string> = {
  QUOTE: "Ajánlat",
  CONTRACT: "Szerződés",
  CERTIFICATE: "Teljesítési igazolás",
};

function when(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString("hu-HU") : "—";
}

export default async function PortalPage() {
  const view = await getPortalView();

  return (
    <AppShell activePath="/portal">
      <div className="grid gap-4">
        <div>
          <h2 className="font-display text-2xl font-bold lowercase tracking-display">
            {view.company ? view.company.name.toLowerCase() : "a projektje"}
          </h2>
          <p className="mt-0.5 text-[12.5px] text-muted">
            A munka állása és a lezárt dokumentumai.
          </p>
        </div>

        {view.notice && (
          <p
            data-testid="portal-notice"
            className="rounded-card border border-line bg-panel p-[18px] text-[12.5px] text-muted"
          >
            {view.notice}
          </p>
        )}

        {view.company && (
          <>
            <section
              data-testid="portal-projects"
              className="rounded-card border border-line bg-panel p-[18px]"
            >
              <h3 className="mb-3 font-display text-lg font-bold lowercase">a munka állása</h3>
              {view.projects.length === 0 ? (
                <p className="text-[12.5px] text-muted">
                  Még nincs elindított projekt. Amint elindul, itt fogja látni a
                  mérföldköveket.
                </p>
              ) : (
                <ul className="grid gap-3">
                  {view.projects.map((p) => {
                    const done = p.milestones.filter((m) => m.doneAt).length;
                    const total = p.milestones.length;
                    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
                    return (
                      <li
                        key={p.id}
                        data-testid="portal-project"
                        className="rounded-[10px] border border-line bg-panel-2 p-3"
                      >
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                          <b className="text-[13px]">{p.name}</b>
                          <span className="text-[11.5px] tabular-nums text-muted">
                            {done} / {total} kész
                            {p.closedAt && " · lezárva"}
                          </span>
                        </div>
                        <div
                          className="mt-2 h-[3px] overflow-hidden rounded-[3px] bg-line"
                          role="progressbar"
                          aria-valuenow={pct}
                          aria-valuemin={0}
                          aria-valuemax={100}
                        >
                          <i
                            className="block h-full rounded-[3px] bg-grad"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <ul className="mt-2.5 grid gap-1">
                          {p.milestones.map((m) => (
                            <li
                              key={m.id}
                              data-testid="portal-milestone"
                              className="flex flex-wrap items-baseline gap-2 text-[12px]"
                            >
                              <span
                                aria-hidden
                                className={m.doneAt ? "text-[#8CEFC0]" : "text-muted"}
                              >
                                {m.doneAt ? "●" : "○"}
                              </span>
                              <span className={m.doneAt ? "text-muted line-through" : "text-ink"}>
                                {m.title}
                              </span>
                              <span className="ml-auto text-[11px] tabular-nums text-muted">
                                {m.doneAt ? when(m.doneAt) : m.dueAt ? `→ ${when(m.dueAt)}` : ""}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            <section
              data-testid="portal-documents"
              className="rounded-card border border-line bg-panel p-[18px]"
            >
              <h3 className="mb-1 font-display text-lg font-bold lowercase">dokumentumok</h3>
              <p className="mb-3 text-[12px] text-muted">
                Csak a véglegesített dokumentumok. Amíg egy ajánlat készül, nem
                látszik itt.
              </p>
              {view.documents.length === 0 ? (
                <p className="text-[12.5px] text-muted">Még nincs véglegesített dokumentum.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[520px] border-collapse text-[12px]">
                    <thead>
                      <tr className="border-b border-line text-left text-[10.5px] uppercase tracking-[0.1em] text-muted">
                        <th className="px-2 py-1.5 font-semibold">Mi</th>
                        <th className="px-2 py-1.5 font-semibold">Szám</th>
                        <th className="px-2 py-1.5 font-semibold">Dátum</th>
                        <th className="px-2 py-1.5 text-right font-semibold">Összeg</th>
                        <th className="px-2 py-1.5" />
                      </tr>
                    </thead>
                    <tbody>
                      {view.documents.map((d) => (
                        <tr
                          key={d.id}
                          data-testid="portal-document"
                          className="border-b border-line last:border-0"
                        >
                          <td className="px-2 py-2 text-ink">{TYPE_LABEL[d.type] ?? d.type}</td>
                          <td className="px-2 py-2 font-mono text-[11.5px] text-muted">
                            {d.number ?? "—"}
                          </td>
                          <td className="whitespace-nowrap px-2 py-2 tabular-nums text-muted">
                            {when(d.finalizedAt)}
                          </td>
                          <td className="px-2 py-2 text-right tabular-nums text-ink">
                            {d.total ?? "—"}
                          </td>
                          <td className="px-2 py-2 text-right">
                            {d.pdfUrl && (
                              <a
                                href={`/api/files/${d.pdfUrl}`}
                                data-testid="portal-document-link"
                                className="rounded-[8px] border border-line px-2.5 py-1 text-[11.5px] font-semibold text-ink hover:border-accent"
                              >
                                PDF
                              </a>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </AppShell>
  );
}
