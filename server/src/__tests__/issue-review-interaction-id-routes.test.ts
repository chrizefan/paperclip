import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  approvals,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueApprovals,
  issueComments,
  issueInboxArchives,
  issueRecoveryActions,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres reviewInteractionId route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("PATCH /api/issues/:id reviewInteractionId", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const enqueueWakeup = vi.fn(async () => ({ id: randomUUID() }));

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-review-interaction-id-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    enqueueWakeup.mockClear();
    await db.delete(issueThreadInteractions);
    await db.delete(issueApprovals);
    await db.delete(approvals);
    await db.delete(issueComments);
    await db.delete(issueRecoveryActions);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issueInboxArchives);
    await db.delete(issues);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(prefix: string) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const operatorUserId = `${prefix.toLowerCase()}-operator`;
    await db.insert(companies).values({
      id: companyId,
      name: `${prefix} Company`,
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `${prefix} Assignee`,
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: operatorUserId,
      status: "active",
      membershipRole: "operator",
    });
    return { companyId, agentId, operatorUserId };
  }

  // An agent PATCH against an in_progress issue must own the checkout run
  // (server/src/routes/issues.ts -> svc.assertCheckoutOwner), so the seeded
  // issue is checked out to the seeded run.
  async function seedIssueWithRun(input: {
    companyId: string;
    agentId: string;
    identifier: string;
    status?: string;
  }) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      identifier: input.identifier,
      title: input.identifier,
      status: input.status ?? "in_progress",
      priority: "medium",
      assigneeAgentId: input.agentId,
    });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      issueId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
    });
    await db
      .update(issues)
      .set({ checkoutRunId: runId, executionRunId: runId })
      .where(eq(issues.id, issueId));
    return { issueId, runId };
  }

  async function seedIssue(input: {
    companyId: string;
    agentId: string;
    identifier: string;
    status?: string;
  }) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      identifier: input.identifier,
      title: input.identifier,
      status: input.status ?? "in_progress",
      priority: "medium",
      assigneeAgentId: input.agentId,
    });
    return issueId;
  }

  async function seedPendingConfirmation(input: {
    companyId: string;
    issueId: string;
    createdByAgentId: string;
    sourceRunId?: string;
  }) {
    const interactionId = randomUUID();
    await db.insert(issueThreadInteractions).values({
      id: interactionId,
      companyId: input.companyId,
      issueId: input.issueId,
      kind: "request_confirmation",
      status: "pending",
      continuationPolicy: "wake_assignee",
      createdByAgentId: input.createdByAgentId,
      sourceRunId: input.sourceRunId ?? null,
      payload: { version: 1, prompt: "Approve entry into review?" },
    });
    return interactionId;
  }

  function app(actor: Record<string, unknown>) {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    testApp.use("/api", issueRoutes(db, {} as any, {
      taskWatchdogEnqueueWakeup: enqueueWakeup as any,
      stalledReviewDecisionEnqueueWakeup: enqueueWakeup as any,
    }));
    testApp.use(errorHandler);
    return testApp;
  }

  function boardActor(companyId: string, userId: string) {
    return {
      type: "board",
      source: "session",
      userId,
      companyIds: [companyId],
      memberships: [{ companyId, status: "active", membershipRole: "operator" }],
      isInstanceAdmin: false,
    };
  }

  function agentActor(companyId: string, agentId: string, runId: string | null = randomUUID()) {
    return {
      type: "agent",
      source: "agent_key",
      companyId,
      agentId,
      runId,
    };
  }

  it("rejects reviewInteractionId when the same PATCH does not ask for in_review", async () => {
    const company = await seedCompany("RID");
    const { issueId, runId } = await seedIssueWithRun({
      companyId: company.companyId,
      agentId: company.agentId,
      identifier: "RID-1",
    });
    const interactionId = await seedPendingConfirmation({
      companyId: company.companyId,
      issueId,
      createdByAgentId: company.agentId,
      sourceRunId: runId,
    });

    const response = await request(app(agentActor(company.companyId, company.agentId, runId)))
      .patch(`/api/issues/${issueId}`)
      .send({ reviewInteractionId: interactionId, title: "Renamed on the way past" });

    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(response.body.error).toEqual(expect.stringContaining("in_review"));
    expect(response.body.error).toEqual(expect.stringContaining("request_confirmation"));
    expect(response.body.error).toEqual(expect.stringContaining("request_checkbox_confirmation"));

    const issue = await request(app(boardActor(company.companyId, company.operatorUserId)))
      .get(`/api/issues/${issueId}`)
      .then((res) => res.body);
    expect(issue.title).toBe("RID-1");
    expect(issue.status).toBe("in_progress");
  });

  it("rejects reviewInteractionId when the same PATCH asks for a status other than in_review", async () => {
    const company = await seedCompany("RID");
    const { issueId, runId } = await seedIssueWithRun({
      companyId: company.companyId,
      agentId: company.agentId,
      identifier: "RID-2",
    });
    const interactionId = await seedPendingConfirmation({
      companyId: company.companyId,
      issueId,
      createdByAgentId: company.agentId,
      sourceRunId: runId,
    });

    const response = await request(app(agentActor(company.companyId, company.agentId, runId)))
      .patch(`/api/issues/${issueId}`)
      .send({ reviewInteractionId: interactionId, status: "in_progress" });

    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(response.body.error).toEqual(expect.stringContaining("in_review"));
  });

  it("rejects reviewInteractionId on an issue that is already in review", async () => {
    const company = await seedCompany("RID");
    const issueId = await seedIssue({
      companyId: company.companyId,
      agentId: company.agentId,
      identifier: "RID-3",
      status: "in_review",
    });
    const interactionId = await seedPendingConfirmation({
      companyId: company.companyId,
      issueId,
      createdByAgentId: company.agentId,
    });

    const response = await request(app(agentActor(company.companyId, company.agentId, null)))
      .patch(`/api/issues/${issueId}`)
      .send({ reviewInteractionId: interactionId });

    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(response.body.error).toEqual(expect.stringContaining("in_review"));
  });

  it("rejects reviewInteractionId for a board actor the same way it does for an agent", async () => {
    const company = await seedCompany("RID");
    const issueId = await seedIssue({
      companyId: company.companyId,
      agentId: company.agentId,
      identifier: "RID-4",
    });

    const response = await request(app(boardActor(company.companyId, company.operatorUserId)))
      .patch(`/api/issues/${issueId}`)
      .send({ reviewInteractionId: randomUUID() });

    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(response.body.error).toEqual(expect.stringContaining("in_review"));
  });

  it("still accepts an ordinary PATCH that carries no reviewInteractionId", async () => {
    const company = await seedCompany("RID");
    const { issueId, runId } = await seedIssueWithRun({
      companyId: company.companyId,
      agentId: company.agentId,
      identifier: "RID-5",
    });

    const response = await request(app(agentActor(company.companyId, company.agentId, runId)))
      .patch(`/api/issues/${issueId}`)
      .send({ title: "Renamed without a review interaction" });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({ id: issueId, title: "Renamed without a review interaction" });
  });

  it("still accepts the real path: reviewInteractionId together with status in_review", async () => {
    const company = await seedCompany("RID");
    const { issueId, runId } = await seedIssueWithRun({
      companyId: company.companyId,
      agentId: company.agentId,
      identifier: "RID-6",
    });
    const interactionId = await seedPendingConfirmation({
      companyId: company.companyId,
      issueId,
      createdByAgentId: company.agentId,
      sourceRunId: runId,
    });

    const response = await request(app(agentActor(company.companyId, company.agentId, runId)))
      .patch(`/api/issues/${issueId}`)
      .send({ reviewInteractionId: interactionId, status: "in_review" });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({ id: issueId, status: "in_review" });
  });
});
