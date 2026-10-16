import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  stripNulDeep,
  stripNulFromHeartbeatPatch,
} from "../services/heartbeat.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping NUL-strip tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// DIG-3981: heartbeat finalization must strip NUL (U+0000) before the
// db.update; Postgres rejects NUL in text/jsonb and the write fails.
describeEmbeddedPostgres("heartbeat NUL strip before finalization update (postgres)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-nul-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await db.$client.end();
    await tempDb?.cleanup();
  });

  async function seedRunningRun() {
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
      name: "NUL Agent",
      role: "engineer",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      contextSnapshot: { triggeredBy: "system" },
    } as typeof heartbeatRuns.$inferInsert);
    return { companyId, agentId, runId };
  }

  it("strips NUL but preserves other control chars", () => {
    expect(stripNulDeep("a\u0000b\nc\td")).toBe("ab\nc\td");
    expect(stripNulDeep({ a: "x\u0000y", nested: ["p\u0000", { q: "r\u0000s" }], n: 1 })).toEqual({
      a: "xy",
      nested: ["p", { q: "rs" }],
      n: 1,
    });
  });

  it("raw NUL text is rejected by Postgres, stripped patch writes clean", async () => {
    const { runId } = await seedRunningRun();

    // Guard-bite control: raw NUL reaches Postgres and is refused.
    await expect(
      db
        .update(heartbeatRuns)
        .set({ error: "boom\u0000here" })
        .where(eq(heartbeatRuns.id, runId)),
    ).rejects.toThrow();

    const patch = stripNulFromHeartbeatPatch({
      error: "boom\u0000here\nkept",
      stdoutExcerpt: "out\u0000",
      stderrExcerpt: "err\u0000",
      usageJson: { note: "a\u0000b", list: ["x\u0000", 2] },
      resultJson: { deep: { msg: "m\u0000" } },
    });

    const rows = await db
      .update(heartbeatRuns)
      .set({ status: "failed", ...patch, updatedAt: new Date() })
      .where(eq(heartbeatRuns.id, runId))
      .returning();
    expect(rows[0]?.error).toBe("boomhere\nkept");
    expect(rows[0]?.stdoutExcerpt).toBe("out");
    expect(rows[0]?.stderrExcerpt).toBe("err");
    expect(rows[0]?.usageJson).toMatchObject({ note: "ab" });
    expect(JSON.stringify(rows[0]?.usageJson)).not.toContain("\u0000");
    expect(JSON.stringify(rows[0]?.resultJson)).not.toContain("\u0000");
  });
});
