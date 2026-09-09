"use client";

import { useCallback, useEffect, useState } from "react";
import { getTaskFields, setTaskField } from "@/modules/tasks/custom-field-actions";
import type { FieldDef, FieldValues } from "@/modules/fields/types";
import { InlineEdit, type InlineKind } from "./inline-edit";
import { attempt } from "@/lib/client/server-action";

/**
 * Owner-defined fields on a task (playbook-v5 P20/2).
 *
 * Rendered through the same inline primitive as everything else, and the
 * type→control mapping is the one the leads table already uses — a custom
 * SELECT should look and behave the same wherever it appears, and two mappings
 * would drift the first time somebody added a type.
 */
const KIND_FOR: Record<string, InlineKind> = {
  TEXT: "text",
  NUMBER: "number",
  DATE: "date",
  SELECT: "select",
  MULTISELECT: "multiselect",
  BOOLEAN: "checkbox",
};

export function TaskFields({ taskId }: { taskId: string }) {
  const [defs, setDefs] = useState<FieldDef[]>([]);
  const [values, setValues] = useState<FieldValues>({});

  const load = useCallback(async () => {
    const res = await getTaskFields(taskId).catch(() => ({ defs: [], values: {} }));
    setDefs(res.defs);
    setValues(res.values);
  }, [taskId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Nothing configured is not an empty state — it is a section that should not
  // be there at all.
  if (defs.length === 0) return null;

  return (
    <div className="mb-3 grid gap-2" data-testid="task-fields">
      <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">
        Your fields
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        {defs.map((def) => {
          const value = values[def.key] ?? null;
          return (
            <label key={def.key} className="block">
              <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
                {def.label}
                {def.required && <span className="text-warn"> *</span>}
              </span>
              <span
                className="block rounded-[8px] border border-line bg-[rgba(0,5,29,0.35)] px-1.5 py-1"
                data-testid={`task-field-${def.key}`}
              >
                <InlineEdit
                  kind={KIND_FOR[def.type] ?? "text"}
                  label={def.label}
                  value={value as string | string[] | boolean | null}
                  options={def.options.map((o) => ({ value: o.value, label: o.label }))}
                  display={displayOf(value, def)}
                  onSave={async (next) => {
                    const res = await attempt(
                      setTaskField({ taskId, key: def.key, value: next }),
                    );
                    if (!res.ok) return res;
                    await load();
                    return { ok: true as const, value: "value" in res ? res.value : next };
                  }}
                />
              </span>
              {def.help && <span className="mt-1 block text-[11px] text-muted">{def.help}</span>}
            </label>
          );
        })}
      </div>
    </div>
  );
}

function displayOf(value: FieldValues[string], def: FieldDef): string {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (Array.isArray(value)) {
    return value.map((v) => def.options.find((o) => o.value === v)?.label ?? v).join(", ");
  }
  return def.options.find((o) => o.value === String(value))?.label ?? String(value);
}
