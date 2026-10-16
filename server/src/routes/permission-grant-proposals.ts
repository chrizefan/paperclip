import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { forbidden, unprocessable } from "../errors.js";
import { authorizationDeniedDetails } from "../services/authorization.js";
import { accessService } from "../services/access.js";
import { createPermissionGrantProposalsService } from "../services/permission-grant-proposals.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

function readScope(value: unknown): Record<string, unknown> | null {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw unprocessable("scope must be an object");
  }
  return value as Record<string, unknown>;
}

function readJustification(value: unknown) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw unprocessable("justification is required");
  }
  return value.trim();
}

function readTargetAgentId(value: unknown) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw unprocessable("targetAgentId is required");
  }
  return value.trim();
}

function readPermissionKey(value: unknown) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw unprocessable("permissionKey is required");
  }
  return value.trim();
}

export function permissionGrantProposalRoutes(db: Db) {
  const router = Router();
  const proposals = createPermissionGrantProposalsService(db);
  const access = accessService(db);

  async function proposalAgentContext(req: Parameters<typeof assertBoard>[0]) {
    if (
      req.actor.type !== "agent"
      || !req.actor.agentId
      || !req.actor.companyId
      || !req.actor.runId
    ) {
      throw forbidden("Run-bound agent authentication required");
    }
    if (
      req.actor.source !== "agent_jwt"
      || req.actor.keyScope?.kind === "task_bridge"
      || req.actor.keyScope?.kind === "skill_test"
    ) {
      throw forbidden("Permission grant proposals require a verified run-bound agent token");
    }
    const decision = await access.decide({
      actor: req.actor,
      action: "permission_grants:propose",
      resource: { type: "company", companyId: req.actor.companyId },
    });
    if (!decision.allowed) {
      throw forbidden(decision.explanation, authorizationDeniedDetails(decision));
    }
    return {
      companyId: req.actor.companyId,
      agentId: req.actor.agentId,
      heartbeatRunId: req.actor.runId,
    };
  }

  router.post("/agents/me/permission-grant-proposals", async (req, res) => {
    const context = await proposalAgentContext(req);
    const body = req.body ?? {};
    if (body.kind !== "permission_grant") {
      throw unprocessable("kind must be permission_grant");
    }
    const proposal = await proposals.create({
      companyId: context.companyId,
      proposedByAgentId: context.agentId,
      originRunId: context.heartbeatRunId,
      targetAgentId: readTargetAgentId(body.targetAgentId),
      permissionKey: readPermissionKey(body.permissionKey),
      scope: readScope(body.scope),
      justification: readJustification(body.justification),
    });
    res.status(201).json(proposal);
  });

  router.delete("/agents/me/permission-grant-proposals/:id", async (req, res) => {
    const context = await proposalAgentContext(req);
    const proposal = await proposals.transition(
      context.companyId,
      req.params.id as string,
      "withdrawn",
      { proposerAgentId: context.agentId },
    );
    res.json(proposal);
  });

  router.post("/companies/:companyId/permission-grant-proposals/:id/approve", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const approved = await proposals.approve(
      companyId,
      req.params.id as string,
      req.actor.type === "board" ? (req.actor.userId ?? "board") : "board",
    );
    res.json(approved);
  });

  router.post("/companies/:companyId/permission-grant-proposals/:id/reject", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    if (!reason) throw unprocessable("Rejection reason is required");
    const proposal = await proposals.transition(
      companyId,
      req.params.id as string,
      "rejected",
      {
        resolvedByUserId: req.actor.type === "board" ? (req.actor.userId ?? "board") : "board",
        reason,
      },
    );
    res.json(proposal);
  });

  return router;
}
