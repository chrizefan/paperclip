import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  CROSS_ISSUE_INFLUENCE_LIMIT,
  observeCrossIssueInfluence,
} from "../services/cross-issue-influence-limit.js";
import { bindRunSourceIssueToCheckout } from "../services/run-source-issue.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping run-source-issue binding tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/**
 * A run that checks an issue out is working that issue, and the cross-issue
 * influence cap reads only the run's admission context. When a run reaches
 * checkout unbound — watchdog wake, board Wake, retry chain — every issue write
 * fails closed with `cross_issue_influence_run_context_required` before the
 * own-issue exemption is reached.
 *
 * These tests hold both halves: the binding fills the gap without ever
 * rebinding a scoped run, and the real guard then exempts the checkout issue
 * while still counting and capping every other issue.
 */
describeEmbeddedPostgres("run source issue binding on checkout (postgres)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-run-source-issue-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await db.$client.end();
    await tempDb?.cleanup();
  });

  async function seedRun(contextSnapshot: Record<string, unknown> | null) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "board-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Checkout Agent",
      role: "engineer",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      contextSnapshot,
    } as typeof heartbeatRuns.$inferInsert);
    return { companyId, agentId, runId };
  }

  async function readSnapshot(runId: string) {
    return db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]?.contextSnapshot ?? null);
  }

  it("binds an unbound run so the guard exempts the issue it checked out", async () => {
    const { companyId, agentId, runId } = await seedRun({
      triggeredBy: "system",
      actorId: null,
    });
    const issueId = randomUUID();

    // Control: unbound, the guard refuses before its own-issue exemption.
    await expect(
      observeCrossIssueInfluence(db, {
        companyId,
        runId,
        agentId,
        targetIssueId: issueId,
        kind: "comment",
      }),
    ).rejects.toThrow();

    await bindRunSourceIssueToCheckout(db, { runId, companyId, issueId });

    expect(await readSnapshot(runId)).toMatchObject({ issueId });

    const own = await observeCrossIssueInfluence(db, {
      companyId,
      runId,
      agentId,
      targetIssueId: issueId,
      kind: "comment",
    });
    expect(own).toBeNull();

    // The cap stays live for every other issue the run reaches.
    const other = await observeCrossIssueInfluence(db, {
      companyId,
      runId,
      agentId,
      targetIssueId: randomUUID(),
      kind: "comment",
    });
    expect(other).toMatchObject({
      allowed: true,
      mode: "enforce",
      count: 1,
      cap: CROSS_ISSUE_INFLUENCE_LIMIT,
    });
  });

  it("keeps the admission scope of an already-scoped run", async () => {
    const admittedFor = randomUUID();
    const { companyId, runId } = await seedRun({
      triggeredBy: "agent",
      issueId: admittedFor,
    });
    const checkedOut = randomUUID();

    await bindRunSourceIssueToCheckout(db, {
      runId,
      companyId,
      issueId: checkedOut,
    });

    // Byte-identical: a task-bound run cannot claim the checked-out issue's
    // own-issue exemption.
    expect(await readSnapshot(runId)).toEqual({ triggeredBy: "agent", issueId: admittedFor });
  });

  it("leaves a taskId-only run scoped to its task", async () => {
    const taskId = randomUUID();
    const { companyId, runId } = await seedRun({ taskId, wakeReason: "issue_comment" });
    const checkedOut = randomUUID();

    await bindRunSourceIssueToCheckout(db, { runId, companyId, issueId: checkedOut });

    expect(await readSnapshot(runId)).toEqual({ taskId, wakeReason: "issue_comment" });
  });

  it("treats a blank issueId as unbound", async () => {
    const { companyId, runId } = await seedRun({ triggeredBy: "system", issueId: "   " });
    const issueId = randomUUID();

    await bindRunSourceIssueToCheckout(db, { runId, companyId, issueId });

    expect(await readSnapshot(runId)).toEqual({ triggeredBy: "system", issueId });
  });

  it("binds a run whose contextSnapshot is null", async () => {
    const { companyId, runId } = await seedRun(null);
    const issueId = randomUUID();

    await bindRunSourceIssueToCheckout(db, { runId, companyId, issueId });

    expect(await readSnapshot(runId)).toEqual({ issueId });
  });

  it("does not bind a run belonging to another company", async () => {
    const other = await seedRun({ triggeredBy: "system" });
    const issueId = randomUUID();

    const bound = await bindRunSourceIssueToCheckout(db, {
      runId: other.runId,
      companyId: randomUUID(),
      issueId,
    });

    expect(bound).toBeNull();
    expect(await readSnapshot(other.runId)).toEqual({ triggeredBy: "system" });
    await db.delete(heartbeatRuns).where(and(eq(heartbeatRuns.id, other.runId)));
  });
});