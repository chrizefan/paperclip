import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import request from "supertest";
import { documentService } from "../services/documents.js";
import { fingerprintSecret } from "../services/secret-detection.js";
import {
  describeEmbeddedPostgres,
  fixture,
  type TestDb,
} from "./helpers/secret-write-detection-fixture.js";

/**
 * DIG-3351: an issue document carrying a secret is refused before it is
 * persisted.
 *
 * `documentService.upsertIssueDocument` guards once at the top, which covers
 * the create path and every conflict-retry path below it (the retry loop
 * re-enters the same function with a newer baseRevisionId).
 */

const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";

function putDocument(app: ReturnType<typeof fixture.createApp>, issueId: string) {
  return request(app).put(`/api/issues/${issueId}/documents/plan`);
}

describeEmbeddedPostgres("issue document secret detection", () => {
  let db!: TestDb;

  beforeAll(async () => {
    db = await fixture.start();
  }, 60_000);

  afterEach(async () => {
    await fixture.reset(db);
  });

  afterAll(async () => {
    await fixture.stop(db);
  });

  it("persists a clean document (201)", async () => {
    const { companyId, issueId } = await fixture.seedIssue(db);
    const response = await putDocument(fixture.createApp(db, companyId), issueId)
      .send({
        title: "Release plan",
        format: "markdown",
        body: "# Plan\n\nShip on Friday after the smoke run.",
      });

    expect(response.status).toBe(201);
    expect(response.body.key).toBe("plan");
    expect(await fixture.countRows(db, "documents", issueId)).toBe(1);
  });

  it("refuses a document whose body carries a secret, with the rule name", async () => {
    const { companyId, issueId } = await fixture.seedIssue(db);
    const response = await putDocument(fixture.createApp(db, companyId), issueId)
      .send({
        title: "Release plan",
        format: "markdown",
        body: `# Plan\n\nDeploy with ${AWS_KEY}.`,
      });

    expect(response.status).toBe(422);
    expect(response.body).toEqual({
      error: "secret_detected",
      rule: "aws_access_key_id",
      fingerprint: fingerprintSecret(AWS_KEY),
    });
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain("AKIA");
    expect(serialized).not.toContain(AWS_KEY);
    expect(serialized).not.toContain(AWS_KEY.slice(0, 8));
    expect(await fixture.countRows(db, "documents", issueId)).toBe(0);
  });

  it("refuses a secret in the document title", async () => {
    const { companyId, issueId } = await fixture.seedIssue(db);
    const response = await putDocument(fixture.createApp(db, companyId), issueId)
      .send({
        title: `Rotate ${AWS_KEY}`,
        format: "markdown",
        body: "# Plan\n\nClean body.",
      });

    expect(response.status).toBe(422);
    expect(response.body.rule).toBe("aws_access_key_id");
    expect(await fixture.countRows(db, "documents", issueId)).toBe(0);
  });

  it("refuses a secret in the change summary", async () => {
    const { companyId, issueId } = await fixture.seedIssue(db);
    const response = await putDocument(fixture.createApp(db, companyId), issueId)
      .send({
        format: "markdown",
        body: "# Plan\n\nClean body.",
        changeSummary: `pasted key ${AWS_KEY}`,
      });

    expect(response.status).toBe(422);
    expect(response.body.rule).toBe("aws_access_key_id");
    expect(await fixture.countRows(db, "documents", issueId)).toBe(0);
  });

  it("leaves an existing document untouched when a later revision carries a secret", async () => {
    const { companyId, issueId } = await fixture.seedIssue(db);
    const app = fixture.createApp(db, companyId);

    const first = await putDocument(app, issueId).send({
      title: "Release plan",
      format: "markdown",
      body: "# Plan\n\nFirst revision.",
    });
    expect(first.status).toBe(201);
    const baseRevisionId = first.body.latestRevisionId as string;
    expect(typeof baseRevisionId).toBe("string");

    const second = await putDocument(app, issueId).send({
      title: "Release plan",
      format: "markdown",
      body: `# Plan\n\nSecond revision with ${AWS_KEY}.`,
      baseRevisionId,
    });

    expect(second.status).toBe(422);
    expect(second.body.rule).toBe("aws_access_key_id");
    // The refused revision left the stored document exactly as it was.
    expect(await fixture.countRows(db, "documents", issueId)).toBe(1);
    const stored = await request(app).get(`/api/issues/${issueId}/documents/plan`);
    expect(stored.status).toBe(200);
    expect(stored.body.body).toBe("# Plan\n\nFirst revision.");
    expect(JSON.stringify(stored.body)).not.toContain("AKIA");
  });

  it("refuses a secret in an import batch before any row is written", async () => {
    const { companyId, issueId } = await fixture.seedIssue(db);
    const row = {
      companyId,
      issueId,
      title: null,
      format: "markdown",
      createdByAgentId: null,
      createdByUserId: null,
      createdByRunId: null,
      sourceTrust: null,
    };

    await expect(
      documentService(db).createIssueDocumentsForImport([
        { ...row, key: "plan", body: "A clean plan." },
        { ...row, key: "notes", body: `deploy key ${AWS_KEY}` },
      ]),
    ).rejects.toMatchObject({ rule: "aws_access_key_id" });
    expect(await fixture.countRows(db, "documents", issueId)).toBe(0);
  });

  it("persists a secret document when the experimental toggle is off", async () => {
    const { companyId, issueId } = await fixture.seedIssue(db);
    const restore = await fixture.withSecretWriteDetection(db, false);
    try {
      expect(await fixture.isSecretWriteDetectionEnabled(db)).toBe(false);
      const response = await putDocument(
        fixture.createApp(db, companyId),
        issueId,
      ).send({
        title: "Release plan",
        format: "markdown",
        body: `# Plan\n\nDeploy with ${AWS_KEY}.`,
      });

      expect(response.status).toBe(201);
      expect(await fixture.countRows(db, "documents", issueId)).toBe(1);
    } finally {
      await restore();
    }
  });

  it("leaves the guard on for the next test after the toggle arm", async () => {
    expect(await fixture.isSecretWriteDetectionEnabled(db)).toBe(true);
  });
});