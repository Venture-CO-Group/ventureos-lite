import Link from "next/link";

/**
 * The outbound motor's sections (playbook-v6). One strip, server-rendered, so
 * every outbound page says where it sits without a client bundle for it.
 */
const TABS = [
  { href: "/outbound", label: "Approval queue" },
  { href: "/outbound/linkedin", label: "LinkedIn queue" },
  { href: "/outbound/runs", label: "Runs" },
  { href: "/outbound/insights", label: "Insights" },
  { href: "/outbound/products", label: "Products & ICP" },
  { href: "/outbound/segments", label: "Segments" },
] as const;

export type OutboundTab = (typeof TABS)[number]["href"];

export function OutboundTabs({ active, right }: { active: OutboundTab; right?: React.ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <h2 className="mr-2 font-display text-[22px] font-extrabold lowercase tracking-display">outbound</h2>
      <nav className="flex min-w-0 flex-1 gap-1 overflow-x-auto" aria-label="Outbound sections">
        {TABS.map((t) => (
          <Link
            key={t.href}
            href={t.href}
            aria-current={t.href === active ? "page" : undefined}
            className={`min-h-[36px] whitespace-nowrap rounded-[9px] border px-3 py-1.5 text-[12.5px] font-semibold ${
              t.href === active ? "border-accent bg-panel text-ink" : "border-line text-muted hover:text-ink"
            }`}
          >
            {t.label}
          </Link>
        ))}
      </nav>
      {right}
    </div>
  );
}
