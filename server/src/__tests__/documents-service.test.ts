import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  documentRevisions,
  documents,
  issueDocuments,
  issues,
} from "@paperclipai/db";
import { ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { documentService } from "../services/documents.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres document service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("documentService system issue documents", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof documentService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-documents-service-");
    db = createDb(tempDb.connectionString);
    svc = documentService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(documentRevisions);
    await db.delete(issueDocuments);
    await db.delete(documents);
    await db.delete(issues);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createIssueWithDocuments() {
    const companyId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "PAP-1600",
      title: "System document filtering",
      description: "Validate document filtering",
      status: "in_progress",
      priority: "medium",
    });

    await svc.upsertIssueDocument({
      issueId,
      key: "plan",
      title: "Plan",
      format: "markdown",
      body: "# Plan",
    });
    await svc.upsertIssueDocument({
      issueId,
      key: ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY,
      title: "Continuation Summary",
      format: "markdown",
      body: "# Handoff",
    });

    return { issueId };
  }

  it("filters continuation summaries from default document lists and issue payload summaries", async () => {
    const { issueId } = await createIssueWithDocuments();

    const defaultDocuments = await svc.listIssueDocuments(issueId);
    expect(defaultDocuments.map((doc) => doc.key)).toEqual(["plan"]);

    const payload = await svc.getIssueDocumentPayload({ id: issueId, description: null });
    expect(payload.planDocument?.key).toBe("plan");
    expect(payload.documentSummaries.map((doc) => doc.key)).toEqual(["plan"]);
  });

  it("keeps system documents available for includeSystem and direct fetch callers", async () => {
    const { issueId } = await createIssueWithDocuments();

    const debugDocuments = await svc.listIssueDocuments(issueId, { includeSystem: true });
    expect(debugDocuments.map((doc) => doc.key)).toEqual([
      ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY,
      "plan",
    ]);

    const directHandoff = await svc.getIssueDocumentByKey(issueId, ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY);
    expect(directHandoff).toEqual(expect.objectContaining({
      key: ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY,
      body: "# Handoff",
    }));
  });

  it("explains the revision guard and rejects missing or stale update revisions without changing the document", async () => {
    const { issueId } = await createIssueWithDocuments();
    const current = (await svc.getIssueDocumentByKey(issueId, "plan"))!;
    const update = {
      issueId,
      key: "plan",
      title: "Plan",
      format: "markdown" as const,
      body: "# Revised plan",
    };

    await expect(svc.upsertIssueDocument(update)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("set baseRevisionId to that latestRevisionId"),
      details: { currentRevisionId: current.latestRevisionId },
    });
    expect(await svc.getIssueDocumentByKey(issueId, "plan")).toMatchObject({
      body: current.body,
      latestRevisionId: current.latestRevisionId,
    });

    const saved = await svc.upsertIssueDocument({ ...update, baseRevisionId: current.latestRevisionId });
    expect(saved.document.body).toBe(update.body);
    expect(saved.document.latestRevisionNumber).toBe(current.latestRevisionNumber + 1);
    await expect(svc.upsertIssueDocument({
      ...update,
      body: "# Stale replacement",
      baseRevisionId: current.latestRevisionId,
    })).rejects.toMatchObject({ status: 409, message: "Document was updated by someone else" });
    expect(await svc.getIssueDocumentByKey(issueId, "plan")).toMatchObject({
      body: saved.document.body,
      latestRevisionId: saved.document.latestRevisionId,
    });
  });

  it("locks and unlocks issue documents", async () => {
    const { issueId } = await createIssueWithDocuments();

    const locked = await svc.lockIssueDocument({
      issueId,
      key: "plan",
      lockedByUserId: "board-user",
    });

    expect(locked.changed).toBe(true);
    expect(locked.document.lockedAt).toBeInstanceOf(Date);
    expect(locked.document.lockedByUserId).toBe("board-user");

    await expect(svc.upsertIssueDocument({
      issueId,
      key: "plan",
      title: "Plan",
      format: "markdown",
      body: "# Updated plan",
      baseRevisionId: locked.document.latestRevisionId,
      createdByUserId: "board-user",
    })).rejects.toMatchObject({
      status: 409,
      message: "Document is locked",
    });

    const unlocked = await svc.unlockIssueDocument(issueId, "plan");
    expect(unlocked.changed).toBe(true);
    expect(unlocked.document.lockedAt).toBeNull();

    const updated = await svc.upsertIssueDocument({
      issueId,
      key: "plan",
      title: "Plan",
      format: "markdown",
      body: "# Updated plan",
      baseRevisionId: unlocked.document.latestRevisionId,
      createdByUserId: "board-user",
    });

    expect(updated.created).toBe(false);
    expect(updated.document.body).toBe("# Updated plan");
  });

  it("creates a new document instead of updating a locked document when requested", async () => {
    const { issueId } = await createIssueWithDocuments();
    const locked = await svc.lockIssueDocument({
      issueId,
      key: "plan",
      lockedByUserId: "board-user",
    });

    const fallback = await svc.upsertIssueDocument({
      issueId,
      key: "plan",
      title: "Plan",
      format: "markdown",
      body: "# Agent replacement plan",
      baseRevisionId: locked.document.latestRevisionId,
      lockedDocumentStrategy: "create_new_document",
    });

    expect(fallback.created).toBe(true);
    expect(fallback.document.key).toBe("plan-2");
    expect(fallback.document.body).toBe("# Agent replacement plan");
    expect("redirectedFromLockedDocument" in fallback ? fallback.redirectedFromLockedDocument : null)
      .toEqual({ id: locked.document.id, key: "plan" });

    const originalPlan = await svc.getIssueDocumentByKey(issueId, "plan");
    expect(originalPlan).toEqual(expect.objectContaining({
      body: "# Plan",
      lockedAt: expect.any(Date),
    }));

    const newPlan = await svc.getIssueDocumentByKey(issueId, "plan-2");
    expect(newPlan).toEqual(expect.objectContaining({
      body: "# Agent replacement plan",
      lockedAt: null,
    }));
  });

  it("keeps the stored title when an update omits it, and clears it on an explicit null", async () => {
    const { issueId } = await createIssueWithDocuments();
    const seeded = (await svc.getIssueDocumentByKey(issueId, "plan"))!;
    expect(seeded.title).toBe("Plan");

    const preserved = await svc.upsertIssueDocument({
      issueId,
      key: "plan",
      format: "markdown",
      body: "# Plan revised without a title",
      baseRevisionId: seeded.latestRevisionId,
    });

    // Positive control: the body moved and the revision counter advanced, so the title that
    // survived is a merge rather than an update that quietly wrote nothing.
    expect(preserved.created).toBe(false);
    expect(preserved.document.body).toBe("# Plan revised without a title");
    expect(preserved.document.latestRevisionNumber).toBe(seeded.latestRevisionNumber + 1);

    // All three update-path writes carry the stored title forward: the return value, the
    // documents row, and the revision row written by this call.
    expect(preserved.document.title).toBe("Plan");
    expect((await svc.getIssueDocumentByKey(issueId, "plan"))!.title).toBe("Plan");
    const afterOmitted = await svc.listIssueDocumentRevisions(issueId, "plan");
    expect(afterOmitted[0]!.revisionNumber).toBe(seeded.latestRevisionNumber + 1);
    expect(afterOmitted[0]!.title).toBe("Plan");

    const cleared = await svc.upsertIssueDocument({
      issueId,
      key: "plan",
      title: null,
      format: "markdown",
      body: "# Plan revised with an explicit null title",
      baseRevisionId: preserved.document.latestRevisionId,
    });

    // A caller that sends null on purpose still clears the title. toBeNull, not toBeFalsy,
    // so an absent field cannot pass as a cleared one.
    expect(cleared.document.title).toBeNull();
    expect((await svc.getIssueDocumentByKey(issueId, "plan"))!.title).toBeNull();
    const afterCleared = await svc.listIssueDocumentRevisions(issueId, "plan");
    expect(afterCleared[0]!.revisionNumber).toBe(seeded.latestRevisionNumber + 2);
    expect(afterCleared[0]!.title).toBeNull();
  });
});
