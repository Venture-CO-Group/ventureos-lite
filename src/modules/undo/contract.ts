/**
 * Every destructive action declares itself (playbook-v5 P16/3).
 *
 * ── WHY A REGISTRY AND NOT A CONVENTION ─────────────────────────────────────
 *
 * "Make destructive things undoable" is the kind of rule that holds for three
 * months and then quietly stops, because the fourth developer to add a delete
 * button does not know the rule exists. So the rule is a list, and a test walks
 * the codebase for destructive exports and fails when one is missing from it.
 *
 * The declaration is deliberately a UNION rather than a boolean: an action may
 * say it has an inverse, or it may say why it has none. What it may not do is
 * stay silent. "Cannot be undone" is a perfectly good answer — a purge that
 * exists to satisfy an erasure request MUST not be reversible — but it has to
 * be an answer somebody wrote down, because that sentence is what the
 * confirmation dialog shows the person about to click it.
 *
 * ── WHAT THIS IS NOT ────────────────────────────────────────────────────────
 *
 * It is not authorization, and it is not a feature flag. It records intent, so
 * that the UI can promise an undo only where one exists, and so that adding a
 * destructive action without thinking about reversal is a failing test rather
 * than a discovery made by a user.
 */

import type { UndoKind } from "./store";

export type Undoability =
  /** An inverse is recorded; the toast may offer Undo. */
  | { undoable: true; kind: UndoKind }
  /**
   * No inverse. `reason` is user-facing — it is the sentence the typed
   * confirmation shows — so it is written for the person, not the developer.
   */
  | { undoable: false; reason: string };

const inverse = (kind: UndoKind): Undoability => ({ undoable: true, kind });
const permanent = (reason: string): Undoability => ({ undoable: false, reason });

/**
 * Keyed by the exported function name, which is what the enforcing test can
 * see. One entry per destructive operation in `src/modules`.
 */
export const DESTRUCTIVE_ACTIONS: Record<string, Undoability> = {
  // ---- has a real inverse -------------------------------------------------
  //
  // Archiving is a flip of `archivedAt`, so the undo engine — which restores
  // FIELDS on rows that still exist — can genuinely reverse it.
  archiveBoard: inverse("board_archive"),

  // A hard delete has no inverse here, and saying otherwise would be the exact
  // lie this file exists to prevent: `undo` re-reads the rows and skips any
  // that are gone, so an "undo" of a delete would report success and restore
  // nothing. Making these reversible means soft-deleting them, which is a
  // schema decision nobody has asked for yet.
  deleteTask: permanent(
    "The task is removed along with its subtasks, comments, attachments and dependency links. There is nothing kept to restore from.",
  ),
  deleteSection: permanent(
    "The column is removed and its tasks become unsectioned on the same board — they are not deleted, but the column cannot be brought back.",
  ),

  dismissDuplicate: permanent(
    "A dismissed pair can be restored from the duplicates list, which is a first-class screen rather than an undo window.",
  ),
  dismissDuplicatePair: permanent(
    "A dismissed pair can be restored from the duplicates list, which is a first-class screen rather than an undo window.",
  ),

  // ---- deliberately permanent, with the sentence a user reads -------------
  deleteLead: permanent(
    "Erasing a lead deletes its activity, messages and documents too, within 72 hours, to satisfy GDPR erasure. Nothing is kept to restore from.",
  ),
  deleteLeadsBulk: permanent(
    "Erasing leads deletes their activity, messages and documents too, within 72 hours, to satisfy GDPR erasure. Nothing is kept to restore from.",
  ),
  deleteUserAccount: permanent(
    "The account and its personal data are erased. Their work stays with the workspace, but the person cannot be restored.",
  ),
  removeMemberFromWorkspace: permanent(
    "Access ends immediately. Their history stays, and re-inviting them creates a new membership rather than reviving this one.",
  ),
  removeMember: permanent(
    "Access ends immediately. Their history stays, and re-inviting them creates a new membership rather than reviving this one.",
  ),
  purgeExpiredNotifications: permanent(
    "A retention sweep, not a user action: it removes what is already past its keep-until date.",
  ),

  // ---- configuration: gone means gone, but nothing of value is lost -------
  deleteRule: permanent("The rule is removed. Its execution log stays, so what it already did remains explicable."),
  deleteWebhook: permanent("The endpoint stops receiving deliveries. Past delivery attempts stay in the log."),
  deleteSchedule: permanent("The schedule stops. Exports it already produced are unaffected."),
  deleteTeam: permanent("The team is removed. Nobody loses access, because a team grants nothing."),
  deleteView: permanent("A saved view is a filter set; rebuilding it costs a few clicks and loses no data."),
  deleteLeadView: permanent("A saved view is a filter set; rebuilding it costs a few clicks and loses no data."),
  deleteTaskView: permanent("A saved board view is a grouping and a filter set; rebuilding it costs a few clicks and loses no tasks."),
  removeTaskView: permanent("A saved board view is a grouping and a filter set; rebuilding it costs a few clicks and loses no tasks."),
  deleteImportTemplate: permanent("A saved column mapping. The rows it imported are unaffected."),
  archiveProjectTemplate: permanent("Archiving hides the template from the picker. Projects created from it are unaffected."),
  removeKeyword: permanent("Tracking stops. The positions already recorded stay in the history."),
  clearAuditWatch: permanent("Watching stops. Audits already run are unaffected."),
  clearComparison: permanent("Only the chosen comparison is cleared; both audits stay."),
  deleteAuditShare: permanent("The public link stops working immediately. That is the point of revoking it."),

  // ---- content and files --------------------------------------------------
  deletePost: permanent("The post and its channel variants are removed."),
  deleteVariant: permanent("This channel's text is removed. The topic and its other channels stay."),
  deleteAttachment: permanent("The file is removed from the task and from disk."),
  removeBrandLogo: permanent("The uploaded logo is removed and the wordmark goes back to the default."),
  removeMyAvatar: permanent("The photo is removed. You can upload another at any time."),
  removeDependency: permanent("The link between the two tasks is removed. Neither task is changed."),
  removeSubscription: permanent("This browser stops receiving push notifications."),
  deleteEntry: permanent(
    "The logged time is removed and the task's actual figure drops by that much. Only the person who logged it can remove it.",
  ),
  removeTimeEntry: permanent(
    "The logged time is removed and the task's actual figure drops by that much. Only the person who logged it can remove it.",
  ),
  removeChecklistItem: permanent(
    "The step is removed from the checklist. The task itself is not changed.",
  ),
  deleteChecklistStep: permanent(
    "The step is removed from the checklist. The task itself is not changed.",
  ),
};

/** What the confirmation should say, for any declared action. */
export function undoabilityOf(action: string): Undoability | null {
  return DESTRUCTIVE_ACTIONS[action] ?? null;
}
