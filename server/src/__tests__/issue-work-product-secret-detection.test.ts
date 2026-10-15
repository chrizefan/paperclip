import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import request from "supertest";
import { fingerprintSecret } from "../services/secret-detection.js";
import {
  describeEmbeddedPostgres,
  fixture,
  type TestDb,
} from "./helpers/secret-write-detection-fixture.js";

/**
 * DIG-3351: an issue work product carrying a secret is refused before it is
 * persisted.
 *
 * `workProductService.createForIssue` / `update` / `createManyForImport` all
 * scan the same eleven free-text and jsonb columns. The batch path matters
 * most: every row is scanned before the first insert, so one bad row cannot
 * half-write an import.
 */

const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";

function cleanWorkProduct() {
  return {
    type: "pull_request" as const,
    provider: "github",
    externalId: "chrizefan/paperclip#9",
    title: "PR #9: refuse secrets in writes",
    status: "active" as const,
    summary: "Extends the DIG-3344 guard to three more surfaces.",
    metadata: { commits: 3, ci: "green" },
  };
}

describeEmbeddedPostgres("issue work product secret detection", () => {
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

  it("persists a clean work product (201)", async () => {
    const { companyId, issueId } = await fixture.seedIssue(db);
    const response = await request(fixture.createApp(db, companyId))
      .post(`/api/issues/${issueId}/work-products`)
      .send(cleanWorkProduct());

    expect(response.status).toBe(201);
    expect(response.body.externalId).toBe("chrizefan/paperclip#9");
    expect(await fixture.countRows(db, "work-products", issueId)).toBe(1);
  });

  it("refuses a work product whose summary carries a secret, with the rule name", async () => {
    const { companyId, issueId } = await fixture.seedIssue(db);
    const response = await request(fixture.createApp(db, companyId))
      .post(`/api/issues/${issueId}/work-products`)
      .send({ ...cleanWorkProduct(), summary: `deploy key ${AWS_KEY}` });

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
    expect(await fixture.countRows(db, "work-products", issueId)).toBe(0);
  });

  it("refuses a secret inside the jsonb metadata column", async () => {
    const { companyId, issueId } = await fixture.seedIssue(db);
    const response = await request(fixture.createApp(db, companyId))
      .post(`/api/issues/${issueId}/work-products`)
      .send({
        ...cleanWorkProduct(),
        metadata: { deploy: { credential: AWS_KEY } },
      });

    expect(response.status).toBe(422);
    expect(response.body.rule).toBe("aws_access_key_id");
    expect(await fixture.countRows(db, "work-products", issueId)).toBe(0);
  });

  it("refuses a secret in the work product title", async () => {
    const { companyId, issueId } = await fixture.seedIssue(db);
    const response = await request(fixture.createApp(db, companyId))
      .post(`/api/issues/${issueId}/work-products`)
      .send({ ...cleanWorkProduct(), title: `Rotate ${AWS_KEY}` });

    expect(response.status).toBe(422);
    expect(response.body.rule).toBe("aws_access_key_id");
    expect(await fixture.countRows(db, "work-products", issueId)).toBe(0);
  });

  it("refuses a secret on an update and leaves the stored row unchanged", async () => {
    const { companyId, issueId } = await fixture.seedIssue(db);
    const app = fixture.createApp(db, companyId);

    const created = await request(app)
      .post(`/api/issues/${issueId}/work-products`)
      .send(cleanWorkProduct());
    expect(created.status).toBe(201);
    const workProductId = created.body.id as string;

    const updated = await request(app)
      .patch(`/api/work-products/${workProductId}`)
      .send({ summary: `updated with ${AWS_KEY}` });

    expect(updated.status).toBe(422);
    expect(updated.body.rule).toBe("aws_access_key_id");
    expect(await fixture.countRows(db, "work-products", issueId)).toBe(1);
    const listed = await request(app).get(`/api/issues/${issueId}/work-products`);
    expect(listed.status).toBe(200);
    expect(JSON.stringify(listed.body)).not.toContain("AKIA");
    expect(JSON.stringify(listed.body)).toContain(
      "Extends the DIG-3344 guard",
    );
  });

  it("persists a secret work product when the experimental toggle is off", async () => {
    const { companyId, issueId } = await fixture.seedIssue(db);
    const restore = await fixture.withSecretWriteDetection(db, false);
    try {
      expect(await fixture.isSecretWriteDetectionEnabled(db)).toBe(false);
      const response = await request(fixture.createApp(db, companyId))
        .post(`/api/issues/${issueId}/work-products`)
        .send({ ...cleanWorkProduct(), summary: `deploy key ${AWS_KEY}` });

      expect(response.status).toBe(201);
      expect(await fixture.countRows(db, "work-products", issueId)).toBe(1);
    } finally {
      await restore();
    }
  });

  it("leaves the guard on for the next test after the toggle arm", async () => {
    expect(await fixture.isSecretWriteDetectionEnabled(db)).toBe(true);
  });
});