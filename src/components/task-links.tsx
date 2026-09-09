"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import Link from "next/link";
import {
  getTaskLinks,
  linkTaskTo,
  searchLinkTargets,
  unlinkTaskFrom,
} from "@/modules/tasks/entity-task-actions";
import { ENTITY_NOUN, entityHref, type EntityKind } from "@/modules/tasks/links";
import { attempt } from "@/lib/client/server-action";
import { useToast } from "./toast";

/**
 * "Also linked to" (playbook-v5 P20/4).
 *
 * ── WHY THE TASK'S OWN ENTITY IS NOT IN HERE ────────────────────────────────
 *
 * A task's main entity is a column on the task, written by twenty different
 * callers and changed by editing the task. What this panel adds and removes
 * are the EXTRA links — the deal-and-its-company case — and the difference is
 * visible: the primary is shown above as the task's entity chip, these are
 * shown here, and trying to add the primary again is refused with a sentence
 * saying it is already there rather than quietly making a second record of one
 * relationship.
 */
const KINDS: EntityKind[] = ["lead", "company", "deal", "project"];

export function TaskLinks({ taskId }: { taskId: string }) {
  const toast = useToast();
  const [links, setLinks] = useState<{ kind: EntityKind; id: string; label: string }[]>([]);
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState<EntityKind>("company");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<{ id: string; label: string; subtitle: string | null }[]>([]);
  const [pending, startTransition] = useTransition();

  const load = useCallback(async () => {
    setLinks(await getTaskLinks(taskId).catch(() => []));
  }, [taskId]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Debounced, because it runs on a keystroke and it is a database query. */
  useEffect(() => {
    if (!adding || query.trim().length < 2) {
      setHits([]);
      return;
    }
    const handle = setTimeout(async () => {
      setHits(await searchLinkTargets(kind, query).catch(() => []));
    }, 200);
    return () => clearTimeout(handle);
  }, [adding, kind, query]);

  function add(entityId: string) {
    startTransition(async () => {
      const res = await attempt(linkTaskTo({ taskId, kind, entityId }));
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setQuery("");
      setHits([]);
      setAdding(false);
      await load();
    });
  }

  function remove(link: { kind: EntityKind; id: string }) {
    startTransition(async () => {
      const res = await attempt(unlinkTaskFrom({ taskId, kind: link.kind, entityId: link.id }));
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      await load();
    });
  }

  return (
    <div className="mb-3" data-testid="task-links">
      <div className="mb-1 flex items-baseline gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">
          Also linked to
        </span>
        <button
          type="button"
          data-testid="task-link-add"
          onClick={() => setAdding((v) => !v)}
          className="text-[11px] text-accent-ink hover:underline"
        >
          {adding ? "Cancel" : "+ link"}
        </button>
      </div>

      {links.length === 0 && !adding && (
        <p className="text-[11.5px] text-muted">
          Only what it is already about. Link it to a second thing when the work genuinely spans
          both.
        </p>
      )}

      {links.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" data-testid="task-link-list">
          {links.map((link) => (
            <li
              key={`${link.kind}:${link.id}`}
              data-testid="task-link"
              className="flex items-center gap-1.5 rounded-full border border-line px-2 py-0.5 text-[11.5px]"
            >
              <Link
                href={entityHref(link.kind, link.id)}
                className="hover:text-accent-ink"
                title={`Open this ${ENTITY_NOUN[link.kind]}`}
              >
                {ENTITY_NOUN[link.kind]}: {link.label}
              </Link>
              <button
                type="button"
                disabled={pending}
                aria-label={`Unlink ${link.label}`}
                data-testid="task-link-remove"
                onClick={() => remove(link)}
                className="text-muted hover:text-[#FFB3C2]"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      {adding && (
        <div className="mt-1.5 grid gap-1.5">
          <div className="flex gap-1.5">
            <select
              value={kind}
              aria-label="What kind of thing to link to"
              data-testid="task-link-kind"
              onChange={(e) => setKind(e.target.value as EntityKind)}
              className="rounded-[8px] border border-line bg-[rgba(0,5,29,0.5)] px-2 py-1.5 text-[12px] text-ink outline-none focus:border-accent"
            >
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {ENTITY_NOUN[k]}
                </option>
              ))}
            </select>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Find a ${ENTITY_NOUN[kind]} by name…`}
              aria-label={`Find a ${ENTITY_NOUN[kind]}`}
              data-testid="task-link-search"
              className="min-w-0 flex-1 rounded-[8px] border border-line bg-[rgba(0,5,29,0.5)] px-2.5 py-1.5 text-[12px] text-ink outline-none focus:border-accent"
            />
          </div>
          {hits.length > 0 && (
            <ul className="grid gap-1" data-testid="task-link-hits">
              {hits.map((hit) => (
                <li key={hit.id}>
                  <button
                    type="button"
                    disabled={pending}
                    data-testid="task-link-hit"
                    onClick={() => add(hit.id)}
                    className="w-full rounded-[8px] border border-line px-2.5 py-1.5 text-left text-[12px] hover:border-accent hover:text-accent-ink"
                  >
                    {hit.label}
                    {hit.subtitle && <span className="ml-1.5 text-muted">{hit.subtitle}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {query.trim().length >= 2 && hits.length === 0 && (
            <p className="text-[11.5px] text-muted">Nothing by that name.</p>
          )}
        </div>
      )}
    </div>
  );
}
