"use client";

import type { FinderRow } from "@/modules/finder/row";
import { FinderResults, type ProfileOption, type ResultsSummary } from "./finder-results";
import { FinderExport, type ExportPolicy } from "./finder-export";

/** The results table with the export dialog in its toolbar — one client boundary for both. */
export function FinderResultsPanel(props: {
  listId: string;
  rows: FinderRow[];
  summary: ResultsSummary;
  profiles: ProfileOption[];
  canAct: boolean;
  exportPolicy: ExportPolicy;
}) {
  const { exportPolicy, ...rest } = props;
  return (
    <FinderResults
      {...rest}
      exportSlot={({ filtered, selected }) => (
        <FinderExport listId={props.listId} total={props.rows.length} filtered={filtered} selected={selected} policy={exportPolicy} />
      )}
    />
  );
}
