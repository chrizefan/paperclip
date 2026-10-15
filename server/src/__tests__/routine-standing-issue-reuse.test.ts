import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  documentRevisions,
  documents,
  executionWorkspaces,
  heartbeatRuns,
  issueComments,
  issues,
  projectWorkspaces,
  projects,
  routineDocuments,
  routineRuns,
  routines,
  routineTriggers,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

import { routineService } from "../services/routines.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type WakeupCall = {
  agentId: string;
  issueId: string | null;
  reason: string | null;
  wakeCommentId: string | null;
};

describeEmbeddedPostgres("routine standing-issue reuse (DIG-3729)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-routine-standing-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(routineRuns);
    await db.delete(routineTriggers);
    await db.delete(routineDocuments);
    await db.delete(routines);
    await db.delete(documents);
    await db.delete(documentRevisions);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /**
   * Seeds a company/agent/project, a standing issue in the requested status, and a
   * routine pointing at that issue.
   *
   * The fake heartbeat mirrors the real dispatcher's shape: it mints a queued
   * heartbeatRuns row and returns its id. That returned id is the non-null runId
   * receipt the append-and-notify arm has to produce - there is no other field in
   * the system that records "a run was queued for this tick".
   */
  async function seedFixture(options?: {
    standingIssueStatus?: string;
    standingIssueCompletedAt?: Date | null;
    concurrencyPolicy?: "coalesce_if_active" | "skip_if_active" | "always_enqueue";
    withStandingIssue?: boolean;
    standingIssueAssignee?: boolean;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const standingIssueId = randomUUID();
    const wakeupCalls: WakeupCall[] = [];

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Standin",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Routines",
      status: "in_progress",
    });

    // The standing issue is an ordinary operator-chosen issue: it is deliberately NOT
    // a routine_execution row and carries no dispatch fingerprint.
    await db.insert(issues).values({
      id: standingIssueId,
      companyId,
      title: "Standing issue",
      status: options?.standingIssueStatus ?? "in_progress",
      priority: "medium",
      assigneeAgentId: options?.standingIssueAssignee === false ? null : agentId,
      completedAt: options?.standingIssueCompletedAt ?? null,
    });

    const svc = routineService(db, {
      heartbeat: {
        wakeup: async (wakeupAgentId, wakeupOpts) => {
          const issueId =
            (typeof wakeupOpts.payload?.issueId === "string" && wakeupOpts.payload.issueId) ||
            (typeof wakeupOpts.contextSnapshot?.issueId === "string" &&
              wakeupOpts.contextSnapshot.issueId) ||
            null;
          const wakeCommentId =
            (typeof wakeupOpts.payload?.wakeCommentId === "string" &&
              wakeupOpts.payload.wakeCommentId) ||
            null;
          wakeupCalls.push({
            agentId: wakeupAgentId,
            issueId,
            reason: wakeupOpts.reason ?? null,
            wakeCommentId,
          });
          if (!issueId) return null;
          const queuedRunId = randomUUID();
          await db.insert(heartbeatRuns).values({
            id: queuedRunId,
            companyId,
            agentId: wakeupAgentId,
            invocationSource: wakeupOpts.source ?? "assignment",
            triggerDetail: wakeupOpts.triggerDetail ?? null,
            status: "queued",
            contextSnapshot: { ...(wakeupOpts.contextSnapshot ?? {}), issueId },
          });
          await db
            .update(issues)
            .set({ executionRunId: queuedRunId, executionLockedAt: new Date() })
            .where(eq(issues.id, issueId));
          return { id: queuedRunId };
        },
      },
    });

    const routine = await svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        standingIssueId: options?.withStandingIssue === false ? null : standingIssueId,
        title: "Standing routine",
        description: "Routine body",
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: options?.concurrencyPolicy ?? "skip_if_active",
        catchUpPolicy: "skip_missed",
      },
      {},
    );

    return { companyId, agentId, standingIssueId, routine, svc, wakeupCalls };
  }

  /** How many issues this executor minted for this routine. Must be 0 on the standing arm. */
  async function countMintedIssues(routineId: string) {
    const rows = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.originKind, "routine_execution"), eq(issues.originId, routineId)));
    return rows.length;
  }

  async function readStanding(standingIssueId: string) {
    const rows = await db.select().from(issues).where(eq(issues.id, standingIssueId));
    return rows[0]!;
  }

  async function readTickComments(standingIssueId: string) {
    const rows = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, standingIssueId));
    return rows;
  }

  // ---- A1: the lookup is keyed on issue id, not on the dispatch fingerprint -------
  it("keeps reusing the standing issue after a routine edit changes the revision fingerprint", async () => {
    const { routine, standingIssueId, svc, wakeupCalls } = await seedFixture();

    await svc.runRoutine(routine.id, { source: "manual" });
    const revisionBefore = routine.latestRevisionId;

    // Editing the routine mints a new revision. routineRevisionId feeds
    // createRoutineDispatchFingerprint, so this is exactly the edit that orphans a
    // fingerprint-keyed match.
    const updated = await svc.update(routine.id, { title: "Standing routine, renamed" }, {});
    expect(updated?.latestRevisionId).toBeTruthy();
    expect(updated?.latestRevisionId).not.toBe(revisionBefore);

    const second = await svc.runRoutine(routine.id, { source: "manual" });

    expect(second.linkedIssueId).toBe(standingIssueId);
    expect(await countMintedIssues(routine.id)).toBe(0);
    expect((await readTickComments(standingIssueId)).length).toBe(2);
    expect(wakeupCalls.length).toBe(2);
  });

  // ---- A2: the headline - mints nothing, still surfaces a served comment wake ----
  it("mints nothing and surfaces a served comment wake on a non-terminal standing issue", async () => {
    const { routine, standingIssueId, agentId, svc, wakeupCalls } = await seedFixture();

    const run = await svc.runRoutine(routine.id, { source: "manual" });

    // No new issue was created for this firing.
    expect(await countMintedIssues(routine.id)).toBe(0);
    expect(run.linkedIssueId).toBe(standingIssueId);
    expect(run.status).toBe("skipped");

    // The tick was appended as a comment authored by the routine, never by the assignee.
    const comments = await readTickComments(standingIssueId);
    expect(comments.length).toBe(1);
    expect(comments[0]!.authorType).toBe("system");
    expect(comments[0]!.authorAgentId).toBeNull();
    expect(comments[0]!.body).toContain("Routine tick");

    // Served: exactly one wake, carrying the comment id, and it produced a queued run
    // row whose id is non-null. The run row only exists because the wake returned an id.
    expect(wakeupCalls.length).toBe(1);
    expect(wakeupCalls[0]!.reason).toBe("issue_commented");
    expect(wakeupCalls[0]!.agentId).toBe(agentId);
    expect(wakeupCalls[0]!.issueId).toBe(standingIssueId);
    expect(wakeupCalls[0]!.wakeCommentId).toBe(comments[0]!.id);

    const queuedRuns = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(queuedRuns.length).toBe(1);
    expect(queuedRuns[0]!.id).toBeTruthy();

    // The standing issue itself was never terminal, so it was left alone.
    const standing = await readStanding(standingIssueId);
    expect(standing.status).toBe("in_progress");
    expect(standing.completedAt).toBeNull();
  });

  // ---- A3: a terminal standing issue is reopened -----------------------------------
  it("reopens a terminal standing issue instead of minting a new one", async () => {
    const completedAt = new Date("2026-10-01T09:00:00.000Z");
    const { routine, standingIssueId, svc } = await seedFixture({
      standingIssueStatus: "done",
      standingIssueCompletedAt: completedAt,
    });

    const run = await svc.runRoutine(routine.id, { source: "manual" });

    expect(run.linkedIssueId).toBe(standingIssueId);
    expect(await countMintedIssues(routine.id)).toBe(0);

    const standing = await readStanding(standingIssueId);
    expect(standing.status).toBe("todo");
    // The reopen advances the counter. A lower bound would pass even when the bump is
    // missing, because the tick's wake advances it too; A3b pins the bump on its own.
    expect(standing.statusVersion).toBeGreaterThan(0);

    const comments = await readTickComments(standingIssueId);
    expect(comments.length).toBe(1);
    expect(comments[0]!.body).toContain("terminal status and was reopened");
  });

  // ---- A4: never clear prior completion -------------------------------------------
  it("preserves completedAt when it reopens a done standing issue", async () => {
    const completedAt = new Date("2026-10-01T09:00:00.000Z");
    const { routine, standingIssueId, svc } = await seedFixture({
      standingIssueStatus: "done",
      standingIssueCompletedAt: completedAt,
    });

    await svc.runRoutine(routine.id, { source: "manual" });

    const standing = await readStanding(standingIssueId);
    expect(standing.status).toBe("todo");
    // The standing issue's record that an earlier tick ran survives the reopen.
    expect(standing.completedAt).not.toBeNull();
    expect(standing.completedAt!.toISOString()).toBe(completedAt.toISOString());
  });

  // ---- A3b: the reopen advances the version counter exactly once ------------------
  it("advances the standing issue version exactly once on reopen, with no wake to mask it", async () => {
    // With an assignee the tick's comment wake runs afterwards and advances the version
    // counter itself, so the reopen's own bump is not observable through the served path.
    // An unassigned standing issue makes queueIssueAssignmentWakeup a no-op, which is the
    // only way to pin that the reopen - not the wake - does the version bump.
    const { routine, standingIssueId, svc, wakeupCalls } = await seedFixture({
      standingIssueStatus: "done",
      standingIssueCompletedAt: new Date("2026-10-01T09:00:00.000Z"),
      standingIssueAssignee: false,
    });

    const before = await readStanding(standingIssueId);
    expect(before.statusVersion).toBe(0);

    await svc.runRoutine(routine.id, { source: "manual" });

    const after = await readStanding(standingIssueId);
    expect(after.status).toBe("todo");
    expect(after.statusVersion).toBe(1);
    // Nothing was woken, so the counter can only have moved because of the reopen.
    expect(wakeupCalls.length).toBe(0);
  });

  // ---- A4b: reopening a cancelled issue clears cancelledAt -------------------------
  it("clears cancelledAt when reopening a cancelled standing issue", async () => {
    const { routine, standingIssueId, svc } = await seedFixture({
      standingIssueStatus: "cancelled",
    });
    await db.update(issues).set({ cancelledAt: new Date() }).where(eq(issues.id, standingIssueId));

    await svc.runRoutine(routine.id, { source: "manual" });

    const standing = await readStanding(standingIssueId);
    expect(standing.status).toBe("todo");
    // isNull(cancelledAt) gates live pipeline membership, so a reopened issue that kept
    // the flag would stay invisible to them.
    expect(standing.cancelledAt).toBeNull();
  });

  // ---- A5: no standing issue set -> unchanged behaviour ----------------------------
  it("still mints one issue per firing when no standing issue is set", async () => {
    const { routine, standingIssueId, svc, wakeupCalls } = await seedFixture({
      withStandingIssue: false,
    });

    const run = await svc.runRoutine(routine.id, { source: "manual" });

    expect(run.status).toBe("issue_created");
    expect(run.linkedIssueId).not.toBe(standingIssueId);
    expect(await countMintedIssues(routine.id)).toBe(1);
    expect(await readTickComments(standingIssueId)).toHaveLength(0);
    expect(wakeupCalls[0]!.reason).toBe("issue_assigned");
  });

  // ---- A6: always_enqueue still mints, never appends to the standing issue ----------
  it("mints a fresh issue and leaves the standing issue untouched under always_enqueue", async () => {
    const { routine, standingIssueId, svc, wakeupCalls } = await seedFixture({
      concurrencyPolicy: "always_enqueue",
    });

    const run = await svc.runRoutine(routine.id, { source: "manual" });

    expect(run.status).toBe("issue_created");
    expect(run.linkedIssueId).not.toBe(standingIssueId);
    expect(await countMintedIssues(routine.id)).toBe(1);
    expect(await readTickComments(standingIssueId)).toHaveLength(0);
    expect(wakeupCalls[0]!.reason).toBe("issue_assigned");
  });

  // ---- API surface: the pointer is company-scoped on both write paths ---------------
  it("accepts a same-company standing issue and refuses another company's, on create and update", async () => {
    const { companyId, standingIssueId, svc } = await seedFixture({ withStandingIssue: false });

    const otherCompanyId = randomUUID();
    const otherAgentId = randomUUID();
    const foreignIssueId = randomUUID();
    await db.insert(companies).values({
      id: otherCompanyId,
      name: "Other Co",
      issuePrefix: `O${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: otherAgentId,
      companyId: otherCompanyId,
      name: "Foreign",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: foreignIssueId,
      companyId: otherCompanyId,
      title: "Foreign issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: otherAgentId,
    });

    // Update: same-company pointer sticks, cross-company pointer is refused, and a
    // refused write leaves the stored pointer untouched.
    const routineId = (await db.select({ id: routines.id }).from(routines).limit(1))[0]!.id;
    const accepted = await svc.update(routineId, { standingIssueId }, {});
    expect(accepted?.standingIssueId).toBe(standingIssueId);

    await expect(
      svc.update(routineId, { standingIssueId: foreignIssueId }, {}),
    ).rejects.toThrow(/same company/);
    expect((await readStanding(standingIssueId)).id).toBe(standingIssueId);

    // Create: the same scope check, on the other write path.
    await expect(
      svc.create(
        companyId,
        {
          projectId: null,
          goalId: null,
          parentIssueId: null,
          standingIssueId: foreignIssueId,
          title: "Rejected at create",
          description: null,
          assigneeAgentId: (await db.select({ id: agents.id }).from(agents).limit(1))[0]!.id,
          priority: "medium",
          status: "active",
          concurrencyPolicy: "skip_if_active",
          catchUpPolicy: "skip_missed",
        },
        {},
      ),
    ).rejects.toThrow(/same company/);
  });

  // ---- the pointer is an operational handle, not routine configuration -------------
  it("sets and clears the standing issue without minting a routine revision", async () => {
    const { routine, standingIssueId, svc } = await seedFixture({ withStandingIssue: false });
    expect(routine.standingIssueId).toBeNull();

    const revisionBefore = routine.latestRevisionId;
    expect(revisionBefore).toBeTruthy();

    // Setting the pointer repoints the routine without changing its configuration, so it
    // must not fork a revision: a revision would feed routineRevisionId into
    // createRoutineDispatchFingerprint and would also re-notify subscribers.
    const set = await svc.update(routine.id, { standingIssueId }, {});
    expect(set?.standingIssueId).toBe(standingIssueId);
    expect(set?.latestRevisionId).toBe(revisionBefore);

    const cleared = await svc.update(routine.id, { standingIssueId: null }, {});
    expect(cleared?.standingIssueId).toBeNull();
    expect(cleared?.latestRevisionId).toBe(revisionBefore);
  });
});
