import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  activityLog,
  assets,
  companies,
  closeRegisteredClients,
  companyMemberships,
  createDb,
  issueAttachments,
  issueComments,
  issueReferenceMentions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { fingerprintSecret } from "../services/secret-detection.js";
import type { StorageService } from "../storage/types.js";

/**
 * LANE V suite for the secret-comment guard (DIG-3344).
 *
 * Proves, against the real route and the persistence choke point:
 *  - a clean comment persists (201);
 *  - a comment carrying a secret is refused with the rule name (422);
 *  - the response carries no value or substring of the value;
 *  - the fingerprint is stable across runs;
 *  - the high-entropy token is caught;
 *  - false positives pass (40-hex, 64-hex sha256, UUID, prose base64);
 *  - the instance experimental toggle turns the guard off.
 */

const externalTestDatabaseUrl = process.env.PAPERCLIP_TEST_DATABASE_URL;
const embeddedPostgresSupport = externalTestDatabaseUrl
  ? { supported: true }
  : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe.sequential
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres secret-detection tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue comment secret detection", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<
    ReturnType<typeof startEmbeddedPostgresTestDatabase>
  > | null = null;

  beforeAll(async () => {
    if (externalTestDatabaseUrl) {
      db = createDb(externalTestDatabaseUrl);
    } else {
      tempDb = await startEmbeddedPostgresTestDatabase(
        "paperclip-secret-detection-",
      );
      db = createDb(tempDb.connectionString);
    }
    await db.execute(sql.raw("CREATE EXTENSION IF NOT EXISTS pg_trgm"));
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueReferenceMentions);
    await db.delete(issueAttachments);
    await db.delete(issueComments);
    await db.delete(assets);
    await db.delete(issues);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    if (externalTestDatabaseUrl) {
      await closeRegisteredClients(externalTestDatabaseUrl);
    }
    await tempDb?.cleanup();
  });

  async function seedIssue() {
    const companyId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Secret Detection Co",
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "SEC-1",
      title: "Secret detection",
      status: "todo",
      priority: "medium",
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "board-user-1",
      status: "active",
      membershipRole: "owner",
      updatedAt: new Date(),
    });
    return { companyId, issueId };
  }

  function createApp(companyId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "board-user-1",
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }],
        source: "cloud_tenant",
        isInstanceAdmin: false,
      };
      next();
    });
    const storage: StorageService = {
      provider: "local_disk",
      putFile: vi.fn(async () => {
        throw new Error("Unexpected storage.putFile call");
      }),
      getObject: vi.fn(async () => {
        throw new Error("Unexpected storage.getObject call");
      }),
      headObject: vi.fn(async () => ({ exists: false })),
      deleteObject: vi.fn(async () => undefined),
    };
    app.use("/api", issueRoutes(db, storage));
    app.use(errorHandler);
    return app;
  }

  async function commentCount(issueId: string) {
    const rows = await db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
    return rows.length;
  }

  it("persists a clean comment (201)", async () => {
    const { companyId, issueId } = await seedIssue();
    const response = await request(createApp(companyId))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "Looks good, thanks. Ship it." });

    expect(response.status).toBe(201);
    expect(response.body.body).toBe("Looks good, thanks. Ship it.");
    expect(await commentCount(issueId)).toBe(1);
  });

  it("refuses a comment carrying an AWS access key with the rule name", async () => {
    const { companyId, issueId } = await seedIssue();
    const secret = "AKIAIOSFODNN7EXAMPLE";
    const body = `deploy key ${secret} please`;

    const response = await request(createApp(companyId))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body });

    expect(response.status).toBe(422);
    expect(response.body).toEqual({
      error: "secret_detected",
      rule: "aws_access_key_id",
      fingerprint: fingerprintSecret(secret),
    });
    // No value, and no substring of the value, anywhere in the response.
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain("AKIA");
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(secret.slice(0, 8));
    // The refused comment never reached the database.
    expect(await commentCount(issueId)).toBe(0);
  });

  it("refuses a comment carrying an Authorization bearer token", async () => {
    const { companyId, issueId } = await seedIssue();
    const token = "b".repeat(32);
    const response = await request(createApp(companyId))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: `curl -H "Authorization: Bearer ${token}" https://x` });

    expect(response.status).toBe(422);
    expect(response.body).toEqual({
      error: "secret_detected",
      rule: "bearer_token",
      fingerprint: fingerprintSecret(token),
    });
    expect(JSON.stringify(response.body)).not.toContain(token);
    expect(await commentCount(issueId)).toBe(0);
  });

  it("catches a 128-hex opaque token as high entropy hex", async () => {
    const { companyId, issueId } = await seedIssue();
    const token = "0123456789abcdef".repeat(8);
    const response = await request(createApp(companyId))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: `session token = ${token}` });

    expect(response.status).toBe(422);
    expect(response.body).toEqual({
      error: "secret_detected",
      rule: "high_entropy_hex",
      fingerprint: fingerprintSecret(token),
    });
    expect(await commentCount(issueId)).toBe(0);
  });

  it("returns a fingerprint that is stable across runs", async () => {
    const { companyId, issueId } = await seedIssue();
    const secret = "AKIAIOSFODNN7EXAMPLE";
    const app = createApp(companyId);

    const first = await request(app)
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: `key ${secret}` });
    const second = await request(app)
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: `key ${secret}` });

    expect(first.status).toBe(422);
    expect(second.status).toBe(422);
    expect(first.body.fingerprint).toBe(second.body.fingerprint);
    expect(first.body.fingerprint).toBe(fingerprintSecret(secret));
    expect(first.body.fingerprint).toMatch(/^[0-9a-f]{12}$/);
  });

  it("lets false positives pass (40-hex, 64-hex, UUID, prose base64)", async () => {
    const { companyId, issueId } = await seedIssue();
    const prose = Buffer.from(
      "The quick brown fox jumps over the lazy dog. This is a plain sentence.",
      "utf8",
    ).toString("base64");
    const body = [
      "git sha 0123456789abcdef0123456789abcdef01234567",
      "sha256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "uuid 123e4567-e89b-12d3-a456-426614174000",
      `notes ${prose}`,
    ].join("\n");

    const response = await request(createApp(companyId))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body });

    expect(response.status).toBe(201);
    expect(await commentCount(issueId)).toBe(1);
  });

  it("persists a secret comment when the experimental toggle is off", async () => {
    const { companyId, issueId } = await seedIssue();
    const settings = instanceSettingsService(db);
    await settings.updateExperimental({ enableSecretWriteDetection: false });
    try {
      const response = await request(createApp(companyId))
        .post(`/api/issues/${issueId}/comments`)
        .send({ body: "key AKIAIOSFODNN7EXAMPLE" });

      expect(response.status).toBe(201);
      expect(await commentCount(issueId)).toBe(1);
    } finally {
      await settings.updateExperimental({ enableSecretWriteDetection: true });
    }
  });
});
