import { Prisma } from "@prisma/client";
import { getRequestRole } from "./request-user";

/**
 * Mandatory Prisma tenant guard (CLAUDE.md hard rule #1).
 *
 * A client extension that auto-scopes every business-table query to a single
 * workspace. It:
 *   - injects `workspace_id = <session>` into the `where` of every read,
 *     update and delete (relying on Prisma's extendedWhereUnique so even
 *     findUnique/update/delete-by-id are constrained — a cross-tenant id
 *     returns null / throws P2025);
 *   - forces `workspace_id = <session>` into the `data` of every create,
 *     overriding any caller-supplied value (no smuggling rows across tenants);
 *   - fails closed: no workspace id -> throw.
 *
 * Global identity/tenancy tables carry no workspace_id and are passed through
 * untouched. Raw queries bypass this guard entirely and are banned by lint
 * (.eslintrc.json) — CLAUDE.md forbids raw queries on business tables.
 */

// Global tables (no workspace_id). Everything else is guarded by default, so a
// newly added business model is tenant-scoped unless it is deliberately global.
const UNGUARDED_MODELS = new Set<string>([
  "User",
  "Session",
  "Membership",
  "Workspace",
  "GoogleCredential",
]);

/**
 * Read-only client access, enforced at the database boundary (P6/6.3).
 *
 * ── WHY HERE AND NOT IN EVERY ACTION ────────────────────────────────────────
 *
 * A read-only role is only as good as its weakest write path. Checking the role
 * inside each server action would mean auditing several hundred mutations and
 * remembering it in every future one — a policy whose failure mode is a silent
 * hole in six months' time.
 *
 * The tenant guard already intercepts every query on every business table. So a
 * CLIENT's write is refused where the write actually happens, which makes the
 * guarantee structural: an action that forgets to check still cannot write.
 *
 * The role comes from async-local storage, published by the session lookup
 * every authenticated path passes through. A background job has no role and is
 * unaffected — a worker is not a signed-in client.
 */
const WRITE_OPERATIONS = new Set([
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "upsert",
  "delete",
  "deleteMany",
]);

/**
 * The one thing a CLIENT may write.
 *
 * Their own reads are audit-logged — "the client opened the contract on the
 * 14th" is a question worth being able to answer — and a policy that could not
 * record that would have to choose between the log and the role.
 */
const CLIENT_WRITABLE_MODELS = new Set(["AuditLog"]);

/** Raised when a read-only membership attempts a write. */
export class ReadOnlyRoleError extends Error {
  constructor(model: string, operation: string) {
    super(`Read-only access: ${operation} on ${model} is not permitted for a client account.`);
    this.name = "ReadOnlyRoleError";
    Object.setPrototypeOf(this, ReadOnlyRoleError.prototype);
  }
}

type AnyArgs = Record<string, unknown>;

function withWorkspaceWhere(args: AnyArgs, workspaceId: string): AnyArgs {
  const where = (args.where as AnyArgs | undefined) ?? {};
  return { ...args, where: { ...where, workspaceId } };
}

function scope(
  operation: string,
  rawArgs: AnyArgs | undefined,
  workspaceId: string,
): AnyArgs {
  const args: AnyArgs = rawArgs ? { ...rawArgs } : {};

  switch (operation) {
    case "create": {
      const data = (args.data as AnyArgs | undefined) ?? {};
      return { ...args, data: { ...data, workspaceId } };
    }
    case "createMany":
    case "createManyAndReturn": {
      const data = args.data;
      return {
        ...args,
        data: Array.isArray(data)
          ? data.map((row) => ({ ...(row as AnyArgs), workspaceId }))
          : { ...((data as AnyArgs | undefined) ?? {}), workspaceId },
      };
    }
    case "upsert": {
      const where = (args.where as AnyArgs | undefined) ?? {};
      const create = (args.create as AnyArgs | undefined) ?? {};
      return {
        ...args,
        where: { ...where, workspaceId },
        create: { ...create, workspaceId },
      };
    }
    default:
      // findUnique(OrThrow), findFirst(OrThrow), findMany, count, aggregate,
      // groupBy, update(Many), delete(Many): constrain by workspace_id.
      return withWorkspaceWhere(args, workspaceId);
  }
}

export function tenantGuard(workspaceId: string) {
  if (!workspaceId) {
    throw new Error("tenantGuard: a workspaceId is required (fails closed)");
  }
  return Prisma.defineExtension({
    name: "tenant-guard",
    query: {
      $allModels: {
        $allOperations({ model, operation, args, query }) {
          // Read-only client access (P6/6.3), checked before the scoping so a
          // refusal cannot depend on the shape of the args.
          if (
            WRITE_OPERATIONS.has(operation) &&
            !CLIENT_WRITABLE_MODELS.has(model) &&
            getRequestRole() === "CLIENT"
          ) {
            throw new ReadOnlyRoleError(model, operation);
          }
          if (UNGUARDED_MODELS.has(model)) {
            return query(args);
          }
          return query(scope(operation, args as AnyArgs, workspaceId));
        },
      },
    },
  });
}
