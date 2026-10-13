import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import request from "supertest";
import { issueThreadInteractions } from "@paperclipai/db";
import { fingerprintSecret } from "../services/secret-detection.js";
import {
  describeEmbeddedPostgres,
  fixture,
  type TestDb,
} from "./helpers/secret-write-detection-fixture.js";

/**
 * DIG-3351: an issue-thread interaction carrying a secret is refused before it
 * is persisted.
 *
 * `issueThreadInteractionService.create` is the single choke point every
 * interaction kind passes through, so a request_confirmation here covers the
 * questions/verdicts/checkbox/task-suggestion kinds by construction; the
 * connection-intent path is guarded by the same helper.
 */

const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";

function cleanConfirmation() {
  return {
    kind: "request_confirmation" as const,
    title: "Confirm the release cut",
    summary: "One question about the release window.",
    payload: {
      version: 1 as const,
      prompt: "Ship digithings on Friday?",
      acceptLabel: "Ship",
      rejectLabel: "Hold",
    },
  };
}

describeEmbeddedPostgres("issue interaction secret detection", () => {
  let db!: TestDb;

  beforeAll(async () => {
    if (!fixture) throw new Error("fixture missing");
    db = await fixture.start();
  }, 60_000);

  afterEach(async () => {
    await fixture.reset(db);
  });

  afterAll(async () => {
    await fixture.stop(db);
  });

  it("persists a clean interaction (201)", async () => {
    const { companyId, issueId } = await fixture.seedIssue(db);
    const response = await request(fixture.createApp(db, companyId))
      .post(`/api/issues/${issueId}/interactions`)
      .send(cleanConfirmation());

    expect(response.status).toBe(201);
    expect(response.body.kind).toBe("request_confirmation");
    expect(await fixture.countRows(db, "interactions", issueId)).toBe(1);
  });

  it("refuses an interaction whose payload carries a secret, with the rule name", async () => {
    const { companyId, issueId } = await fixture.seedIssue(db);
    const response = await request(fixture.createApp(db, companyId))
      .post(`/api/issues/${issueId}/interactions`)
      .send({
        ...cleanConfirmation(),
        payload: {
          ...cleanConfirmation().payload,
          prompt: `Use ${AWS_KEY} for the deploy window?`,
        },
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
    expect(await fixture.countRows(db, "interactions", issueId)).toBe(0);
  });

  it("refuses a secret in the interaction title, not only in the payload", async () => {
    const { companyId, issueId } = await fixture.seedIssue(db);
    const response = await request(fixture.createApp(db, companyId))
      .post(`/api/issues/${issueId}/interactions`)
      .send({ ...cleanConfirmation(), title: `Rotate ${AWS_KEY} first` });

    expect(response.status).toBe(422);
    expect(response.body.rule).toBe("aws_access_key_id");
    expect(await fixture.countRows(db, "interactions", issueId)).toBe(0);
  });

  it("refuses a secret in the interaction summary", async () => {
    const { companyId, issueId } = await fixture.seedIssue(db);
    const response = await request(fixture.createApp(db, companyId))
      .post(`/api/issues/${issueId}/interactions`)
      .send({ ...cleanConfirmation(), summary: `key ${AWS_KEY}` });

    expect(response.status).toBe(422);
    expect(response.body.rule).toBe("aws_access_key_id");
    expect(await fixture.countRows(db, "interactions", issueId)).toBe(0);
  });

  it("persists a secret interaction when the experimental toggle is off", async () => {
    const { companyId, issueId } = await fixture.seedIssue(db);
    const restore = await fixture.withSecretWriteDetection(db, false);
    try {
      expect(await fixture.isSecretWriteDetectionEnabled(db)).toBe(false);
      const response = await request(fixture.createApp(db, companyId))
        .post(`/api/issues/${issueId}/interactions`)
        .send({
          ...cleanConfirmation(),
          payload: {
            ...cleanConfirmation().payload,
            prompt: `Use ${AWS_KEY} for the deploy window?`,
          },
        });

      expect(response.status).toBe(201);
      expect(await fixture.countRows(db, "interactions", issueId)).toBe(1);
    } finally {
      await restore();
    }
  });

  it("leaves the guard on for the next test after the toggle arm", async () => {
    expect(await fixture.isSecretWriteDetectionEnabled(db)).toBe(true);
    const rows = await db
      .select({ id: issueThreadInteractions.id })
      .from(issueThreadInteractions);
    expect(rows.length).toBe(0);
  });
});