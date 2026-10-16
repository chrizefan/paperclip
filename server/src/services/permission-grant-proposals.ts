import { and, eq } from "drizzle-orm";
import {
  agents,
  companyMemberships,
  permissionGrantProposals,
  principalPermissionGrants,
  type Db,
} from "@paperclipai/db";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";

export const GRANTABLE_PERMISSION_KEYS = ["agents:configure", "agents:suggest-changes"] as const;
export type GrantablePermissionKey = (typeof GRANTABLE_PERMISSION_KEYS)[number];

const GRANTABLE = new Set<string>(GRANTABLE_PERMISSION_KEYS);

export function assertGrantablePermissionKey(
  permissionKey: string,
): asserts permissionKey is GrantablePermissionKey {
  if (!GRANTABLE.has(permissionKey)) {
    throw unprocessable(
      "Only agents:configure and agents:suggest-changes can be granted through this proposal",
    );
  }
}

/**
 * Add or update one permission key and leave every other key in place.
 * Deleting the principal's grant set and inserting only this key is the
 * DIG-1915 replace mutant. The merge-preserving approve test must fail it.
 */
export async function mergePermissionGrant(
  tx: Db,
  input: {
    companyId: string;
    targetAgentId: string;
    permissionKey: GrantablePermissionKey;
    scope: Record<string, unknown> | null;
    grantedByUserId: string | null;
  },
) {
  const now = new Date();
  const membership = await tx
    .select({ id: companyMemberships.id })
    .from(companyMemberships)
    .where(
      and(
        eq(companyMemberships.companyId, input.companyId),
        eq(companyMemberships.principalType, "agent"),
        eq(companyMemberships.principalId, input.targetAgentId),
      ),
    )
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (!membership) {
    await tx.insert(companyMemberships).values({
      companyId: input.companyId,
      principalType: "agent",
      principalId: input.targetAgentId,
      status: "active",
      membershipRole: "member",
    });
  }

  const existing = await tx
    .select()
    .from(principalPermissionGrants)
    .where(
      and(
        eq(principalPermissionGrants.companyId, input.companyId),
        eq(principalPermissionGrants.principalType, "agent"),
        eq(principalPermissionGrants.principalId, input.targetAgentId),
        eq(principalPermissionGrants.permissionKey, input.permissionKey),
      ),
    )
    .for("update")
    .then((rows) => rows[0] ?? null);

  if (existing) {
    await tx
      .update(principalPermissionGrants)
      .set({
        scope: input.scope ?? existing.scope,
        updatedAt: now,
      })
      .where(eq(principalPermissionGrants.id, existing.id));
    return;
  }

  await tx.insert(principalPermissionGrants).values({
    companyId: input.companyId,
    principalType: "agent",
    principalId: input.targetAgentId,
    permissionKey: input.permissionKey,
    scope: input.scope,
    grantedByUserId: input.grantedByUserId,
    createdAt: now,
    updatedAt: now,
  });
}

export function createPermissionGrantProposalsService(db: Db) {
  async function getById(
    companyId: string,
    proposalId: string,
    dbClient: Db = db,
    lockForUpdate = false,
  ) {
    const query = dbClient
      .select()
      .from(permissionGrantProposals)
      .where(
        and(
          eq(permissionGrantProposals.id, proposalId),
          eq(permissionGrantProposals.companyId, companyId),
        ),
      );
    const rows = lockForUpdate ? await query.for("update") : await query;
    return rows[0] ?? null;
  }

  async function requirePending(
    companyId: string,
    proposalId: string,
    dbClient: Db = db,
    lockForUpdate = false,
  ) {
    const proposal = await getById(companyId, proposalId, dbClient, lockForUpdate);
    if (!proposal) throw notFound("Permission grant proposal not found");
    if (proposal.status !== "pending") throw conflict("Only pending proposals can be resolved");
    return proposal;
  }

  async function assertTargetInCompany(companyId: string, targetAgentId: string, dbClient: Db = db) {
    const target = await dbClient
      .select({ id: agents.id, companyId: agents.companyId })
      .from(agents)
      .where(eq(agents.id, targetAgentId))
      .then((rows) => rows[0] ?? null);
    if (!target || target.companyId !== companyId) {
      throw unprocessable("Target agent is not in this company");
    }
  }

  async function create(input: {
    companyId: string;
    proposedByAgentId: string;
    originRunId: string;
    targetAgentId: string;
    permissionKey: string;
    scope: Record<string, unknown> | null;
    justification: string;
  }) {
    assertGrantablePermissionKey(input.permissionKey);
    await assertTargetInCompany(input.companyId, input.targetAgentId);
    const [row] = await db
      .insert(permissionGrantProposals)
      .values({
        companyId: input.companyId,
        kind: "permission_grant",
        status: "pending",
        targetAgentId: input.targetAgentId,
        permissionKey: input.permissionKey,
        scope: input.scope,
        justification: input.justification,
        proposedByAgentId: input.proposedByAgentId,
        originRunId: input.originRunId,
      })
      .returning();
    if (!row) throw conflict("Permission grant proposal was not created");
    return row;
  }

  async function approve(companyId: string, proposalId: string, resolvedByUserId: string) {
    return db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      const proposal = await requirePending(companyId, proposalId, txDb, true);
      assertGrantablePermissionKey(proposal.permissionKey);
      await assertTargetInCompany(companyId, proposal.targetAgentId, txDb);
      await mergePermissionGrant(txDb, {
        companyId,
        targetAgentId: proposal.targetAgentId,
        permissionKey: proposal.permissionKey,
        scope: proposal.scope,
        grantedByUserId: resolvedByUserId,
      });
      const now = new Date();
      const [updated] = await txDb
        .update(permissionGrantProposals)
        .set({
          status: "approved",
          resolvedByUserId,
          resolvedAt: now,
          updatedAt: now,
        })
        .where(eq(permissionGrantProposals.id, proposal.id))
        .returning();
      if (!updated) throw conflict("Permission grant proposal was not approved");
      return updated;
    });
  }

  async function transition(
    companyId: string,
    proposalId: string,
    status: "rejected" | "withdrawn",
    input: {
      resolvedByUserId?: string | null;
      proposerAgentId?: string | null;
      reason?: string | null;
    } = {},
  ) {
    return db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      const proposal = await requirePending(companyId, proposalId, txDb, true);
      if (status === "withdrawn" && proposal.proposedByAgentId !== input.proposerAgentId) {
        throw forbidden("Only the proposer can withdraw this proposal");
      }
      const now = new Date();
      const [updated] = await txDb
        .update(permissionGrantProposals)
        .set({
          status,
          resolvedByUserId: input.resolvedByUserId ?? null,
          resolutionReason: input.reason ?? null,
          resolvedAt: now,
          updatedAt: now,
        })
        .where(eq(permissionGrantProposals.id, proposal.id))
        .returning();
      if (!updated) throw conflict("Permission grant proposal was not updated");
      return updated;
    });
  }

  return { getById, create, approve, transition };
}
