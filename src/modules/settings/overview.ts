import { getWorkspaceClient, prismaUnsafe } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { auditRetentionDaysFrom, describeAuditRetention } from "../auditlog/retention";
import { securityPolicyFrom } from "../workspaces/security-policy";
import { hiddenFeatures } from "../workspaces/nav-visibility";
import { isDefaultBrand, brandFrom } from "../workspaces/brand";
import { DEFAULT_AUDIT_THRESHOLDS, auditThresholdsFromConfig } from "../audit/config";

/**
 * What the admin index says behind each section (P8/3).
 *
 * ── WHAT THIS IS FOR, AND WHAT IT IS NOT ────────────────────────────────────
 *
 * Not a dashboard. The only question the index answers is "where do I go, and
 * is anything here still on a default I meant to change" — because a default
 * nobody chose is the thing that goes unnoticed for a year. So every fact is
 * either a count somebody would want to check at a glance, or a flag saying
 * "this is still the out-of-the-box value".
 *
 * `attention` is deliberately sparing. If half the lines are amber, none of
 * them are.
 */
export interface OverviewFact {
  label: string;
  value: string;
  /** Draw it amber: still a default, or a number that wants looking at. */
  attention?: boolean;
}

export type AdminOverview = Record<string, OverviewFact[]>;

export async function getAdminOverview(): Promise<AdminOverview> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  const ws = await prismaUnsafe.workspace.findUnique({
    where: { id: workspaceId },
    select: { featureFlags: true, brand: true, auditConfig: true },
  });
  const flags = ws?.featureFlags ?? null;

  const [
    memberCount,
    suspendedCount,
    fieldCount,
    workflowCount,
    activeWorkflows,
    targetCount,
    projectTemplateCount,
    webhookCount,
    enabledWebhooks,
    watchCount,
    auditLogCount,
    pendingProposals,
  ] = await Promise.all([
    prismaUnsafe.membership.count({ where: { workspaceId, suspendedAt: null } }),
    prismaUnsafe.membership.count({ where: { workspaceId, suspendedAt: { not: null } } }),
    db.customFieldDef.count({ where: { archived: false } }),
    db.workflowRule.count(),
    db.workflowRule.count({ where: { enabled: true } }),
    db.target.count(),
    db.projectTemplate.count({ where: { status: "active" } }),
    db.webhook.count(),
    db.webhook.count({ where: { enabled: true } }),
    db.auditWatch.count({ where: { enabled: true } }),
    db.auditLog.count(),
    db.proposal.count({ where: { status: "PENDING" } }),
  ]);

  const hidden = hiddenFeatures(flags);
  const policy = securityPolicyFrom(flags);
  const retentionDays = auditRetentionDaysFrom(flags);
  const scoring = auditThresholdsFromConfig(ws?.auditConfig);
  const scoringIsDefault =
    JSON.stringify(scoring) === JSON.stringify(DEFAULT_AUDIT_THRESHOLDS);

  return {
    members: [
      { label: "Active", value: String(memberCount) },
      ...(suspendedCount > 0
        ? [{ label: "Suspended", value: String(suspendedCount), attention: true }]
        : []),
    ],
    workspace: [
      {
        label: "Letterhead",
        value: isDefaultBrand(brandFrom(ws?.brand)) ? "still the default" : "set",
        attention: isDefaultBrand(brandFrom(ws?.brand)),
      },
      { label: "Custom fields", value: String(fieldCount) },
      {
        label: "Workflow rules",
        value: workflowCount === 0 ? "none" : `${activeWorkflows} on of ${workflowCount}`,
      },
      ...(hidden.size > 0 ? [{ label: "Menu items hidden", value: String(hidden.size) }] : []),
    ],
    sales: [
      { label: "Targets", value: targetCount === 0 ? "none set" : String(targetCount), attention: targetCount === 0 },
      { label: "Milestone templates", value: String(projectTemplateCount) },
      ...(pendingProposals > 0
        ? [{ label: "Proposals waiting", value: String(pendingProposals), attention: true }]
        : []),
    ],
    audit: [
      {
        label: "Scoring",
        value: scoringIsDefault ? "on the defaults" : "tuned",
        attention: scoringIsDefault,
      },
      { label: "Sites watched", value: String(watchCount) },
    ],
    integrations: [
      {
        label: "Webhooks",
        value: webhookCount === 0 ? "none" : `${enabledWebhooks} on of ${webhookCount}`,
      },
    ],
    security: [
      {
        label: "Two-factor",
        value: policy.require2fa ? "required" : "optional",
        attention: !policy.require2fa,
      },
      { label: "Audit log", value: `${auditLogCount} entries` },
      {
        label: "Log retention",
        value: describeAuditRetention(retentionDays).replace("Kept ", ""),
      },
    ],
    workspaces: [],
  };
}
