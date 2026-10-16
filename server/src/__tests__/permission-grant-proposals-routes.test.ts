import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  permissionGrantProposals,
  principalPermissionGrants,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/error-handler.js";
import { permissionGrantProposalRoutes } from "../routes/permission-grant-proposals.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const BOARD_ONLY_CONFIGURE =
  "No grant exists for agents:configure, and only the board can create one.";

describeEmbeddedPostgres("permission grant proposal routes", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("permission-grant-proposals");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  });

  afterEach(async () => {
    await db.delete(permissionGrantProposals);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
  });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const targetAgentId = randomUUID();
    const heartbeatRunId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Permission grants",
      issuePrefix: `G${companyId.slice(0, 7)}`.toUpperCase(),
      status: "active",
    });
    await db.insert(agents).values([
      {
        id: agentId,
        companyId,
        name: "Proposer",
        role: "engineer",
        adapterType: "codex_local",
        adapterConfig: {},
        permissions: {},
        status: "idle",
      },
      {
        id: targetAgentId,
        companyId,
        name: "Target",
        role: "engineer",
        adapterType: "codex_local",
        adapterConfig: {},
        permissions: {},
        status: "idle",
      },
    ]);
    await db.insert(heartbeatRuns).values({
      id: heartbeatRunId,
      companyId,
      agentId,
      status: "running",
      responsibleUserId: "user-1",
      contextSnapshot: {},
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "agent",
      principalId: targetAgentId,
      status: "active",
      membershipRole: "member",
    });
    await db.insert(principalPermissionGrants).values({
      companyId,
      principalType: "agent",
      principalId: targetAgentId,
      permissionKey: "tasks:assign",
      scope: { keep: true },
      grantedByUserId: "board",
    });
    return { companyId, agentId, targetAgentId, heartbeatRunId };
  }

  function createAgentApp(
    fixture: Awaited<ReturnType<typeof seed>>,
    source: "agent_jwt" | "agent_key" = "agent_jwt",
  ) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "agent",
        agentId: fixture.agentId,
        companyId: fixture.companyId,
        runId: fixture.heartbeatRunId,
        source,
        keyScope: { kind: "standard" },
      };
      next();
    });
    app.use("/api", permissionGrantProposalRoutes(db));
    app.use(errorHandler);
    return app;
  }

  function createBoardApp(fixture: Awaited<ReturnType<typeof seed>>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "board",
        userId: "board-user",
        companyIds: [fixture.companyId],
        source: "local_implicit",
      };
      next();
    });
    app.use("/api", permissionGrantProposalRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function grantsFor(companyId: string, agentId: string) {
    return db
      .select()
      .from(principalPermissionGrants)
      .where(
        and(
          eq(principalPermissionGrants.companyId, companyId),
          eq(principalPermissionGrants.principalType, "agent"),
          eq(principalPermissionGrants.principalId, agentId),
        ),
      );
  }

  it("lets an agent without agents:configure leave a pending proposal", async () => {
    const fixture = await seed();
    const res = await request(createAgentApp(fixture))
      .post("/api/agents/me/permission-grant-proposals")
      .send({
        kind: "permission_grant",
        targetAgentId: fixture.targetAgentId,
        permissionKey: "agents:configure",
        scope: { team: "ops" },
        justification: "Need configure to install a skill",
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      status: "pending",
      kind: "permission_grant",
      permissionKey: "agents:configure",
      targetAgentId: fixture.targetAgentId,
    });
    const keys = (await grantsFor(fixture.companyId, fixture.targetAgentId)).map((row) => row.permissionKey);
    expect(keys).toEqual(["tasks:assign"]);
  });

  it("approve merges the new key and preserves existing grants", async () => {
    // Replace-instead-of-merge (delete the principal's grants, then insert only
    // the approved key) fails this test. That mutant is the DIG-1915 bug.
    const fixture = await seed();
    const proposed = await request(createAgentApp(fixture))
      .post("/api/agents/me/permission-grant-proposals")
      .send({
        kind: "permission_grant",
        targetAgentId: fixture.targetAgentId,
        permissionKey: "agents:configure",
        scope: { team: "ops" },
        justification: "Need configure to install a skill",
      });
    expect(proposed.status).toBe(201);

    const approved = await request(createBoardApp(fixture))
      .post(`/api/companies/${fixture.companyId}/permission-grant-proposals/${proposed.body.id}/approve`)
      .send({});

    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe("approved");
    const rows = await grantsFor(fixture.companyId, fixture.targetAgentId);
    expect(rows.map((row) => row.permissionKey).sort()).toEqual(["agents:configure", "tasks:assign"]);
    expect(rows.find((row) => row.permissionKey === "tasks:assign")?.scope).toEqual({ keep: true });
    expect(rows.find((row) => row.permissionKey === "agents:configure")?.scope).toEqual({ team: "ops" });
  });

  it("refuses an unknown key and a second approve", async () => {
    const fixture = await seed();
    const [unknown] = await db
      .insert(permissionGrantProposals)
      .values({
        companyId: fixture.companyId,
        kind: "permission_grant",
        status: "pending",
        targetAgentId: fixture.targetAgentId,
        permissionKey: "tasks:assign",
        scope: { replaced: true },
        justification: "This key is not grantable here",
        proposedByAgentId: fixture.agentId,
        originRunId: fixture.heartbeatRunId,
      })
      .returning();

    const refused = await request(createBoardApp(fixture))
      .post(`/api/companies/${fixture.companyId}/permission-grant-proposals/${unknown!.id}/approve`)
      .send({});
    expect(refused.status).toBe(422);
    const afterRefusal = await grantsFor(fixture.companyId, fixture.targetAgentId);
    expect(afterRefusal.map((row) => row.permissionKey)).toEqual(["tasks:assign"]);
    expect(afterRefusal[0]?.scope).toEqual({ keep: true });

    const proposed = await request(createAgentApp(fixture))
      .post("/api/agents/me/permission-grant-proposals")
      .send({
        kind: "permission_grant",
        targetAgentId: fixture.targetAgentId,
        permissionKey: "agents:suggest-changes",
        justification: "Suggest only",
      });
    expect(proposed.status).toBe(201);
    const first = await request(createBoardApp(fixture))
      .post(`/api/companies/${fixture.companyId}/permission-grant-proposals/${proposed.body.id}/approve`)
      .send({});
    expect(first.status).toBe(200);
    const second = await request(createBoardApp(fixture))
      .post(`/api/companies/${fixture.companyId}/permission-grant-proposals/${proposed.body.id}/approve`)
      .send({});
    expect(second.status).toBe(409);
    const keys = (await grantsFor(fixture.companyId, fixture.targetAgentId)).map((row) => row.permissionKey).sort();
    expect(keys).toEqual(["agents:suggest-changes", "tasks:assign"]);
  });

  it("withdraws a pending proposal without writing a grant", async () => {
    const fixture = await seed();
    const proposed = await request(createAgentApp(fixture))
      .post("/api/agents/me/permission-grant-proposals")
      .send({
        kind: "permission_grant",
        targetAgentId: fixture.targetAgentId,
        permissionKey: "agents:configure",
        justification: "Changed my mind",
      });
    const withdrawn = await request(createAgentApp(fixture))
      .delete(`/api/agents/me/permission-grant-proposals/${proposed.body.id}`);
    expect(withdrawn.status).toBe(200);
    expect(withdrawn.body.status).toBe("withdrawn");
    const approved = await request(createBoardApp(fixture))
      .post(`/api/companies/${fixture.companyId}/permission-grant-proposals/${proposed.body.id}/approve`)
      .send({});
    expect(approved.status).toBe(409);
    const keys = (await grantsFor(fixture.companyId, fixture.targetAgentId)).map((row) => row.permissionKey);
    expect(keys).toEqual(["tasks:assign"]);
  });

  it("names the board as the only granter when an agent lacks agents:configure", async () => {
    const { authorizationService } = await import("../services/authorization.js");
    const fixture = await seed();
    await db.insert(companyMemberships).values({
      companyId: fixture.companyId,
      principalType: "agent",
      principalId: fixture.agentId,
      status: "active",
      membershipRole: "member",
    });
    const decision = await authorizationService(db).decide({
      actor: {
        type: "agent",
        agentId: fixture.agentId,
        companyId: fixture.companyId,
        source: "agent_key",
      },
      action: "agent_config:update",
      resource: { type: "agent", companyId: fixture.companyId, agentId: fixture.targetAgentId },
      scope: { requiresChangeGrant: true },
    });
    expect(decision).toMatchObject({
      allowed: false,
      reason: "deny_no_grant",
      explanation: BOARD_ONLY_CONFIGURE,
    });
    expect(decision.explanation).toContain("only the board can create one");
  });
});
