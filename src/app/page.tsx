import { AppShell } from "@/components/app-shell";
import { Greeting } from "@/components/greeting";
import { TasksPanel } from "@/components/tasks-panel";
import { myTasks } from "@/modules/tasks/actions";
import { getLatestInsight } from "@/modules/signal/actions";
import { Onboarding } from "@/components/onboarding";
import { getOnboarding } from "@/modules/onboarding/actions";

export const dynamic = "force-dynamic";

export default async function Home() {
  // Tasks are fetched HERE, on the server, and handed to the panel as a prop.
  // The dashboard is the first page loaded every morning; a client round trip
  // for its main list costs a flash and real latency on a phone.
  const [insight, tasks, onboarding] = await Promise.all([
    getLatestInsight(),
    myTasks(),
    getOnboarding(),
  ]);
  const initialTasks = [
    ...tasks.overdue,
    ...tasks.today,
    ...tasks.upcoming,
    ...tasks.someday,
  ];

  return (
    <AppShell activePath="/">
      <div className="max-w-[1400px] grid gap-4">
        {/* First-login tour and the getting-started checklist (P7/4). */}
        <Onboarding view={onboarding} />

        {/*
          ---- the greeting, full width and compact ----

          It used to be one of three children in a two-column grid, which meant
          the third child wrapped into the second row and left a hole beside it.
          The greeting is a header, so it behaves like one now.
        */}
        <div className="rounded-card border border-line bg-panel px-6 py-5 backdrop-blur-sm">
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
            Today
          </div>
          <h2 className="mb-1.5 font-display text-2xl font-bold lowercase tracking-display">
            <Greeting />
          </h2>
          <p className="max-w-prose text-[12.5px] leading-relaxed text-muted">
            Your day starts with the list on the left. Everything on it lives on
            a task board — open one to see its subtasks, comments and what it is
            waiting on.
          </p>
        </div>

        {/*
          ---- work on the left, thinking on the right ----

          The task list is what the dashboard is FOR — it is the first thing
          read every morning — so it takes the wide column rather than a 360px
          rail. The Claude insight and the Signal Engine note are context: worth
          having on screen, never worth reading first.
        */}
        <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[1fr_340px]">
          <TasksPanel initial={initialTasks} />

          <div className="grid gap-4">
            {/* Claude insight card — the only glowing element (spec §4.13) */}
            <div className="rounded-card border-[1.5px] border-transparent bg-[linear-gradient(rgba(4,8,34,0.92),rgba(4,8,34,0.92))_padding-box,linear-gradient(135deg,#310B59,#7427C6)_border-box] p-[18px] shadow-[0_0_24px_rgba(116,39,198,0.18)]">
              <div className="mb-2 flex items-center gap-2 text-[12px] font-semibold">
                <span className="grid h-5 w-5 place-items-center rounded-full bg-accent-soft text-accent-ink">
                  ✦
                </span>
                <b>Claude insight</b>
                <span className="ml-auto text-[11px] font-normal text-muted">today</span>
              </div>
              {insight ? (
                <p className="text-[13px] leading-relaxed text-[#D8DCEF]">{insight.body}</p>
              ) : (
                <p className="text-[13px] leading-relaxed text-muted">
                  No insight yet — the Signal Engine runs weekly and the daily card rotates
                  over its digest. Come back after the first run.
                </p>
              )}
            </div>

            <div className="rounded-card border border-line bg-panel p-[18px]">
              <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
                Signal Engine
              </div>
              <p className="text-[12.5px] leading-relaxed text-muted">
                Runs weekly on aggregates. Proposals (frame promotion, score weights) require
                n≥20 and wait for your approval in{" "}
                <a href="/settings/admin/sales" className="text-accent-ink">
                  Settings → sales
                </a>
                . Nothing self-modifies.
              </p>
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
