import { randomUUID } from "node:crypto";
import express, { type Express } from "express";
import { eq, sql } from "drizzle-orm";
import { vi } from "vitest";
import {
  activityLog,
  assets,
  closeRegisteredClients,
  companyMemberships,
  companies,
  createDb,
  issueAttachments,
  issueComments,
  issueDocuments,
  issueReferenceMentions,
  issueThreadInteractions,
  issueWorkProducts,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./embedded-postgres.js";
import { errorHandler } from "../../middleware/index.js";
import { issueRoutes } from "../../routes/issues.js";
import { instanceSettingsService } from "../../services/instance-settings.js";
import type { StorageService } from "../../storage/types.js";

/**
 * Shared harness for the DIG-3351 secret-write guard route suites
 * (interactions, documents, work products).
 *
 * It is the DIG-3344 comment-suite harness factored out: same embedded
 * Postgres boot, same board actor, same issueRoutes mounting, so a guard
 * failure on one surface is comparable with the others. Each surface file
 * owns its own boot, so any single surface can be run on its own.
 *
 * Exported `describeEmbeddedPostgres` is `describe.skip` on a host that cannot
 * boot Postgres. That makes a route suite vacuously green there, which is why
 * every surface file also carries a pure unit assertion that needs no database
 * (see secret-write-fields.test.ts for the entry point itself).
 */

export const externalTestDatabaseUrl = process.env.PAPERCLIP_TEST_DATABASE_URL;

const embeddedPostgresSupport = externalTestDatabaseUrl
  ? { supported: true as const, reason: undefined }
  : await getEmbeddedPostgresTestSupport();

export const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe.sequential
  : describe.skip;

export const embeddedPostgresUnsupportedReason =
  embeddedPostgresSupport.reason ?? "unsupported environment";

export type TestDb = ReturnType<typeof createDb>;

export interface SecretWriteFixture {
  db: TestDb;
  /** Boot a throwaway database and return its handle. */
  start(): Promise<TestDb>;
  /** Remove every row this suite creates, in dependency order. */
  reset(db: TestDb): Promise<void>;
  /** Tear the boot down. */
  stop(db: TestDb): Promise<void>;
  /** A fresh company + issue, addressable by the board actor below. */
  seedIssue(db: TestDb, title?: string): Promise<{ companyId: string; issueId: string }>;
  /** Express app wired exactly like the DIG-3344 suite, for any issue surface. */
  createApp(db: TestDb, companyId: string): Express;
  /** True when the instance is running the guard (the shipped default). */
  isSecretWriteDetectionEnabled(db: TestDb): Promise<boolean>;
  /** Flip the instance flag, returning a restore function. */
  withSecretWriteDetection(
    db: TestDb,
    enabled: boolean,
  ): Promise<() => Promise<void>>;
  /** Rows of `table` belonging to `issueId` - the "never persisted" receipt. */
  countRows(db: TestDb, surface: GuardedSurface, issueId: string): Promise<number>;
}

export type GuardedSurface = "interactions" | "documents" | "work-products";

const ISSUE_SCOPED_TABLES = [
  issueThreadInteractions,
  issueDocuments,
  issueWorkProducts,
] as const;

const COUNTED_TABLES: Record<GuardedSurface, typeof issueDocuments> = {
  interactions: issueThreadInteractions as unknown as typeof issueDocuments,
  documents: issueDocuments,
  "work-products": issueWorkProducts as unknown as typeof issueDocuments,
};

export const fixture: SecretWriteFixture = {
  async start() {
    if (externalTestDatabaseUrl) {
      const db = createDb(externalTestDatabaseUrl);
      await db.execute(sql.raw("CREATE EXTENSION IF NOT EXISTS pg_trgm"));
      return db;
    }
    const tempDb = await startEmbeddedPostgresTestDatabase(
      "paperclip-secret-write-guard-",
    );
    const db = createDb(tempDb.connectionString);
    await db.execute(sql.raw("CREATE EXTENSION IF NOT EXISTS pg_trgm"));
    // Keep the temp handle reachable for cleanup by stashing it on the db.
    (db as unknown as { __tempDb: unknown }).__tempDb = tempDb;
    return db;
  },

  async reset(db) {
    for (const table of ISSUE_SCOPED_TABLES) {
      await db.delete(table);
    }
    await db.delete(activityLog);
    await db.delete(issueReferenceMentions);
    await db.delete(issueAttachments);
    await db.delete(issueComments);
    await db.delete(assets);
    await db.delete(issues);
    await db.delete(companyMemberships);
    await db.delete(companies);
  },

  async stop(db) {
    if (externalTestDatabaseUrl) {
      await closeRegisteredClients(externalTestDatabaseUrl);
      return;
    }
    const tempDb = (db as unknown as { __tempDb?: { cleanup?: () => Promise<void> } })
      .__tempDb;
    await tempDb?.cleanup?.();
  },

  async seedIssue(db, title = "Secret write detection") {
    const companyId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Secret Write Detection Co",
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "SEC-1",
      title,
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
  },

  createApp(db, companyId) {
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
  },

  async isSecretWriteDetectionEnabled(db) {
    const settings = await instanceSettingsService(db).getExperimental();
    return settings.enableSecretWriteDetection;
  },

  async withSecretWriteDetection(db, enabled) {
    const settings = instanceSettingsService(db);
    const before = (await settings.getExperimental()).enableSecretWriteDetection;
    await settings.updateExperimental({ enableSecretWriteDetection: enabled });
    return async () => {
      await settings.updateExperimental({ enableSecretWriteDetection: before });
    };
  },

  async countRows(db, surface, issueId) {
    const table = COUNTED_TABLES[surface];
    const rows = await db
      .select({ id: table.id })
      .from(table)
      .where(eq(table.issueId, issueId));
    return rows.length;
  },
};