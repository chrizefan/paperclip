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

  async function createIssueWithDocuments(options: { identifier?: string } = {}) {
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
      identifier: options.identifier ?? "PAP-1600",
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

    return { companyId, issueId };
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

  async function insertKeyedDocument(input: {
    companyId: string;
    issueId: string;
    key: string;
    title: string;
    body: string;
  }) {
    const documentId = randomUUID();
    const revisionId = randomUUID();

    await db.insert(documents).values({
      id: documentId,
      companyId: input.companyId,
      title: input.title,
      format: "markdown",
      latestBody: input.body,
      latestRevisionId: revisionId,
      latestRevisionNumber: 1,
    });
    await db.insert(documentRevisions).values({
      id: revisionId,
      companyId: input.companyId,
      documentId,
      revisionNumber: 1,
      title: input.title,
      format: "markdown",
      body: input.body,
      changeSummary: "Created",
    });
    await db.insert(issueDocuments).values({
      id: randomUUID(),
      companyId: input.companyId,
      issueId: input.issueId,
      documentId,
      key: input.key,
    });

    return { documentId, revisionId };
  }

  // Models the six orphans already in the instance: a write addressed by document
  // id created a second document whose KEY is that id, so a by-key lookup resolves
  // the shadow row instead of the document the caller meant.
  async function createIssueWithUuidKeyedShadowDocuments() {
    const { companyId, issueId } = await createIssueWithDocuments();
    const plan = await svc.getIssueDocumentByKey(issueId, "plan");
    const keyOnlyUuid = randomUUID();
    const planIdShadow = await insertKeyedDocument({
      companyId,
      issueId,
      key: plan!.id,
      title: "Shadow keyed by the plan document id",
      body: "# Shadow addressed by document id",
    });
    const keyOnlyShadow = await insertKeyedDocument({
      companyId,
      issueId,
      key: keyOnlyUuid,
      title: "Shadow keyed by an unrelated uuid",
      body: "# Shadow keyed by an unrelated uuid",
    });

    return { companyId, issueId, plan, keyOnlyUuid, planIdShadow, keyOnlyShadow };
  }

  it("resolves a uuid document reference by document id, not by a shadow row keyed with that id", async () => {
    const { issueId, plan } = await createIssueWithUuidKeyedShadowDocuments();

    const resolved = await svc.getIssueDocumentByKey(issueId, plan!.id);

    expect(resolved).toEqual(expect.objectContaining({
      id: plan!.id,
      key: "plan",
      body: "# Plan",
    }));
  });

  it("never resolves a uuid document reference by key when it is not a document id on the issue", async () => {
    const { issueId, keyOnlyUuid } = await createIssueWithUuidKeyedShadowDocuments();

    expect(await svc.getIssueDocumentByKey(issueId, keyOnlyUuid)).toBeNull();
  });

  it("does not resolve a document id that belongs to another issue", async () => {
    const { issueId } = await createIssueWithUuidKeyedShadowDocuments();
    const other = await createIssueWithDocuments({ identifier: "PAP-1601" });
    const otherPlan = await svc.getIssueDocumentByKey(other.issueId, "plan");

    expect(await svc.getIssueDocumentByKey(issueId, otherPlan!.id)).toBeNull();
  });

  it("lists revisions for a uuid document reference by document id", async () => {
    const { issueId, plan } = await createIssueWithUuidKeyedShadowDocuments();

    const revisions = await svc.listIssueDocumentRevisions(issueId, plan!.id);

    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({ key: "plan", documentId: plan!.id, body: "# Plan" });
  });

  it("locks and unlocks a uuid document reference by document id", async () => {
    const { issueId, plan } = await createIssueWithUuidKeyedShadowDocuments();

    const locked = await svc.lockIssueDocument({
      issueId,
      key: plan!.id,
      lockedByUserId: "board-user",
    });

    expect(locked.changed).toBe(true);
    expect(locked.document.id).toBe(plan!.id);
    expect(locked.document.lockedByUserId).toBe("board-user");

    const unlocked = await svc.unlockIssueDocument(issueId, plan!.id);

    expect(unlocked.changed).toBe(true);
    expect(unlocked.document.id).toBe(plan!.id);
    expect(unlocked.document.lockedAt).toBeNull();
  });

  it("deletes a uuid document reference by document id and leaves the shadow rows alone", async () => {
    const { issueId, plan, planIdShadow, keyOnlyShadow } = await createIssueWithUuidKeyedShadowDocuments();

    const removed = await svc.deleteIssueDocument(issueId, plan!.id);

    expect(removed).toEqual(expect.objectContaining({ id: plan!.id, key: "plan" }));

    const remaining = await svc.listIssueDocuments(issueId, { includeSystem: true });
    expect(remaining.map((doc) => doc.key)).not.toContain("plan");
    expect(remaining.map((doc) => doc.id)).toEqual(
      expect.arrayContaining([planIdShadow.documentId, keyOnlyShadow.documentId]),
    );
  });

  it("restores a revision through a uuid document reference by document id", async () => {
    const { issueId, plan } = await createIssueWithUuidKeyedShadowDocuments();
    await svc.upsertIssueDocument({
      issueId,
      key: "plan",
      title: "Plan",
      format: "markdown",
      body: "# Plan v2",
      baseRevisionId: plan!.latestRevisionId,
    });

    const restored = await svc.restoreIssueDocumentRevision({
      issueId,
      key: plan!.id,
      revisionId: plan!.latestRevisionId,
    });

    expect(restored.restoredFromRevisionNumber).toBe(1);
    expect(restored.document.id).toBe(plan!.id);
    expect(restored.document.body).toBe("# Plan");
    expect(restored.document.latestRevisionNumber).toBe(3);
  });

  it("refuses a uuid-shaped document key on write and creates no document", async () => {
    const { issueId } = await createIssueWithDocuments();
    const plan = await svc.getIssueDocumentByKey(issueId, "plan");

    await expect(svc.upsertIssueDocument({
      issueId,
      key: plan!.id,
      title: "Plan",
      format: "markdown",
      body: "# Written by document id",
    })).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/document\s+id/i),
      details: { key: plan!.id },
    });

    const after = await svc.listIssueDocuments(issueId, { includeSystem: true });
    expect(after.map((doc) => doc.key)).toEqual([ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY, "plan"]);
  });

  it("accepts a document key that merely contains a uuid substring", async () => {
    const { issueId } = await createIssueWithDocuments();
    const key = `plan-${randomUUID()}`;

    const created = await svc.upsertIssueDocument({
      issueId,
      key,
      title: "Plan",
      format: "markdown",
      body: "# Key that contains a uuid substring",
    });

    expect(created.created).toBe(true);
    expect(created.document.key).toBe(key);
  });
});
