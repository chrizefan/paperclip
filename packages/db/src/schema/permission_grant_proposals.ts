import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

export const permissionGrantProposals = pgTable(
  "permission_grant_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    kind: text("kind").notNull().default("permission_grant"),
    status: text("status").notNull().default("pending"),
    targetAgentId: uuid("target_agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    permissionKey: text("permission_key").notNull(),
    scope: jsonb("scope").$type<Record<string, unknown> | null>(),
    justification: text("justification").notNull(),
    proposedByAgentId: uuid("proposed_by_agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    originRunId: uuid("origin_run_id").notNull().references(() => heartbeatRuns.id, { onDelete: "cascade" }),
    resolvedByUserId: text("resolved_by_user_id"),
    resolutionReason: text("resolution_reason"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("permission_grant_proposals_company_status_idx").on(table.companyId, table.status),
    proposerStatusIdx: index("permission_grant_proposals_proposer_status_idx").on(
      table.proposedByAgentId,
      table.status,
    ),
    kindCheck: check(
      "permission_grant_proposals_kind_check",
      sql`${table.kind} = 'permission_grant'`,
    ),
    statusCheck: check(
      "permission_grant_proposals_status_check",
      sql`${table.status} in ('pending', 'approved', 'rejected', 'withdrawn')`,
    ),
  }),
);
