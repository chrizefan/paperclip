import { describe, expect, it } from "vitest";
import {
  ISSUE_REWAKE_BASE_COOLDOWN_MS,
  ISSUE_REWAKE_MAX_COOLDOWN_MS,
  ISSUE_REWAKE_NO_PROGRESS_THRESHOLD,
  computeIssueRewakeCooldownMs,
  evaluateIssueRewakeThrottle,
  isThrottleCandidateIssueRewake,
} from "../services/issue-rewake-throttle.ts";

const NOW = new Date("2026-07-12T18:14:00.000Z");

function runSample(input: {
  id: string;
  status?: string;
  finishedSecondsAgo: number;
}) {
  return {
    id: input.id,
    status: input.status ?? "succeeded",
    finishedAt: new Date(NOW.getTime() - input.finishedSecondsAgo * 1000),
  };
}

describe("isThrottleCandidateIssueRewake", () => {
  const base = {
    reason: "issue_assigned",
    wakeCommentId: null,
    requestedByActorType: "system" as const,
    forceFreshSession: false,
    hasExplicitResume: false,
  };

  it("throttles state-poll reasons and reason-less invokes", () => {
    expect(isThrottleCandidateIssueRewake(base)).toBe(true);
    expect(isThrottleCandidateIssueRewake({ ...base, reason: null })).toBe(true);
    expect(isThrottleCandidateIssueRewake({ ...base, reason: "issue_continuation_needed" })).toBe(true);
    expect(isThrottleCandidateIssueRewake({ ...base, reason: "issue_assignment_recovery" })).toBe(true);
    expect(isThrottleCandidateIssueRewake({ ...base, reason: "issue_graph_liveness_backstop" })).toBe(true);
  });

  it("keeps agent comments throttle-eligible without granting human comment privileges", () => {
    expect(isThrottleCandidateIssueRewake({
      ...base,
      reason: "issue_commented",
      wakeCommentId: "comment-1",
      requestedByActorType: "agent",
    })).toBe(true);
    expect(isThrottleCandidateIssueRewake({
      ...base,
      reason: "issue_commented",
      wakeCommentId: "comment-1",
      requestedByActorType: "user",
    })).toBe(false);
  });

  it("never throttles trusted explicit escalation wakes", () => {
    expect(isThrottleCandidateIssueRewake({ ...base, forceFreshSession: true })).toBe(false);
    expect(isThrottleCandidateIssueRewake({ ...base, hasExplicitResume: true })).toBe(false);
  });

  it("keeps agent-authored explicit resume comments throttle-eligible", () => {
    expect(isThrottleCandidateIssueRewake({
      ...base,
      reason: "issue_reopened_via_comment",
      wakeCommentId: "comment-1",
      requestedByActorType: "agent",
      hasExplicitResume: true,
    })).toBe(true);
  });

  it("passes event-shaped wake reasons through", () => {
    for (const reason of [
      "issue_commented",
      "issue_comment_mentioned",
      "issue_blockers_resolved",
      "issue_children_completed",
      "issue_monitor_due",
      "process_lost_retry",
      "run_liveness_continuation",
    ]) {
      expect(isThrottleCandidateIssueRewake({ ...base, reason })).toBe(false);
    }
  });
});

describe("computeIssueRewakeCooldownMs", () => {
  it("starts at the base cooldown and doubles per extra no-progress run, capped", () => {
    expect(computeIssueRewakeCooldownMs(ISSUE_REWAKE_NO_PROGRESS_THRESHOLD)).toBe(ISSUE_REWAKE_BASE_COOLDOWN_MS);
    expect(computeIssueRewakeCooldownMs(ISSUE_REWAKE_NO_PROGRESS_THRESHOLD + 1)).toBe(ISSUE_REWAKE_BASE_COOLDOWN_MS * 2);
    expect(computeIssueRewakeCooldownMs(ISSUE_REWAKE_NO_PROGRESS_THRESHOLD + 3)).toBe(ISSUE_REWAKE_BASE_COOLDOWN_MS * 8);
    expect(computeIssueRewakeCooldownMs(100)).toBe(ISSUE_REWAKE_MAX_COOLDOWN_MS);
  });
});

describe("evaluateIssueRewakeThrottle", () => {
  it("allows when there is no run history", () => {
    expect(
      evaluateIssueRewakeThrottle({
        now: NOW,
        recentTerminalRuns: [],
        runIdsWithIssueProgress: new Set(),
        hasNewIssueInputSinceLastRun: false,
      }),
    ).toEqual({ blocked: false, noProgressStreak: 0 });
  });

  it("allows below the no-progress threshold", () => {
    const decision = evaluateIssueRewakeThrottle({
      now: NOW,
      recentTerminalRuns: [runSample({ id: "r1", finishedSecondsAgo: 10 })],
      runIdsWithIssueProgress: new Set(),
      hasNewIssueInputSinceLastRun: false,
    });
    expect(decision).toEqual({ blocked: false, noProgressStreak: 1 });
  });

  it("blocks inside the cooldown once the streak reaches the threshold", () => {
    const decision = evaluateIssueRewakeThrottle({
      now: NOW,
      recentTerminalRuns: [
        runSample({ id: "r2", finishedSecondsAgo: 10 }),
        runSample({ id: "r1", finishedSecondsAgo: 40 }),
      ],
      runIdsWithIssueProgress: new Set(),
      hasNewIssueInputSinceLastRun: false,
    });
    expect(decision.blocked).toBe(true);
    if (decision.blocked) {
      expect(decision.noProgressStreak).toBe(2);
      expect(decision.cooldownMs).toBe(ISSUE_REWAKE_BASE_COOLDOWN_MS);
      expect(decision.nextAllowedAt.getTime()).toBe(
        NOW.getTime() - 10_000 + ISSUE_REWAKE_BASE_COOLDOWN_MS,
      );
    }
  });

  it("allows again after the cooldown elapses", () => {
    const decision = evaluateIssueRewakeThrottle({
      now: NOW,
      recentTerminalRuns: [
        runSample({ id: "r2", finishedSecondsAgo: ISSUE_REWAKE_BASE_COOLDOWN_MS / 1000 + 1 }),
        runSample({ id: "r1", finishedSecondsAgo: ISSUE_REWAKE_BASE_COOLDOWN_MS / 1000 + 30 }),
      ],
      runIdsWithIssueProgress: new Set(),
      hasNewIssueInputSinceLastRun: false,
    });
    expect(decision).toEqual({ blocked: false, noProgressStreak: 2 });
  });

  it("escalates the cooldown as the streak grows", () => {
    const decision = evaluateIssueRewakeThrottle({
      now: NOW,
      recentTerminalRuns: [
        runSample({ id: "r4", finishedSecondsAgo: 10 }),
        runSample({ id: "r3", finishedSecondsAgo: 30 }),
        runSample({ id: "r2", finishedSecondsAgo: 60 }),
        runSample({ id: "r1", finishedSecondsAgo: 90 }),
      ],
      runIdsWithIssueProgress: new Set(),
      hasNewIssueInputSinceLastRun: false,
    });
    expect(decision.blocked).toBe(true);
    if (decision.blocked) {
      expect(decision.noProgressStreak).toBe(4);
      expect(decision.cooldownMs).toBe(ISSUE_REWAKE_BASE_COOLDOWN_MS * 4);
    }
  });

  it("resets at the most recent run with issue-visible progress", () => {
    const decision = evaluateIssueRewakeThrottle({
      now: NOW,
      recentTerminalRuns: [
        runSample({ id: "r3", finishedSecondsAgo: 10 }),
        runSample({ id: "r2", finishedSecondsAgo: 40 }),
        runSample({ id: "r1", finishedSecondsAgo: 70 }),
      ],
      runIdsWithIssueProgress: new Set(["r2"]),
      hasNewIssueInputSinceLastRun: false,
    });
    expect(decision).toEqual({ blocked: false, noProgressStreak: 1 });
  });

  it("does not delay recovery after a failed run", () => {
    const decision = evaluateIssueRewakeThrottle({
      now: NOW,
      recentTerminalRuns: [
        runSample({ id: "r2", status: "failed", finishedSecondsAgo: 10 }),
        runSample({ id: "r1", finishedSecondsAgo: 40 }),
      ],
      runIdsWithIssueProgress: new Set(),
      hasNewIssueInputSinceLastRun: false,
    });
    expect(decision).toEqual({ blocked: false, noProgressStreak: 0 });
  });

  it("allows when new issue input landed after the last run", () => {
    const decision = evaluateIssueRewakeThrottle({
      now: NOW,
      recentTerminalRuns: [
        runSample({ id: "r2", finishedSecondsAgo: 10 }),
        runSample({ id: "r1", finishedSecondsAgo: 40 }),
      ],
      runIdsWithIssueProgress: new Set(),
      hasNewIssueInputSinceLastRun: true,
    });
    expect(decision).toEqual({ blocked: false, noProgressStreak: 0 });
  });
});

describe("DIG-3744: comment-only no-op runs do not reset the streak", () => {
  function noopRun(id: string, finishedSecondsAgo: number, livenessState = "needs_followup") {
    return { id, status: "succeeded", finishedAt: new Date(NOW.getTime() - finishedSecondsAgo * 1000), livenessState };
  }

  function commentOnlyProgress(ids: string[]) {
    return {
      runIdsWithIssueProgress: new Set(ids),
      // No non-comment activity on any run.
      runIdsWithStrongProgress: new Set<string>(),
    };
  }

  it("blocks the 1-per-minute state-check loop (8 identical no-op runs)", () => {
    // DIG-1575: 12 consecutive `needs_followup` "State check only" runs,
    // each posting a status comment ~60s apart. Pre-fix every comment
    // counted as progress, so the streak never reached the threshold.
    const ids = Array.from({ length: 8 }, (_, i) => `r${8 - i}`);
    const runs = ids.map((id, i) => noopRun(id, 10 + i * 60));
    const decision = evaluateIssueRewakeThrottle({
      now: NOW,
      recentTerminalRuns: runs,
      ...commentOnlyProgress(ids),
      hasNewIssueInputSinceLastRun: false,
    });
    expect(decision.blocked).toBe(true);
    if (decision.blocked) {
      expect(decision.noProgressStreak).toBe(8);
      expect(decision.cooldownMs).toBe(ISSUE_REWAKE_MAX_COOLDOWN_MS);
    }
  });

  it("blocks comment-only empty_response runs at the threshold", () => {
    const decision = evaluateIssueRewakeThrottle({
      now: NOW,
      recentTerminalRuns: [
        noopRun("r2", 10, "empty_response"),
        noopRun("r1", 40, "empty_response"),
      ],
      ...commentOnlyProgress(["r2", "r1"]),
      hasNewIssueInputSinceLastRun: false,
    });
    expect(decision.blocked).toBe(true);
    if (decision.blocked) {
      expect(decision.noProgressStreak).toBe(2);
      expect(decision.cooldownMs).toBe(ISSUE_REWAKE_BASE_COOLDOWN_MS);
    }
  });

  it("still allows a comment-only run whose liveness is productive", () => {
    const decision = evaluateIssueRewakeThrottle({
      now: NOW,
      recentTerminalRuns: [
        { ...noopRun("r2", 10), livenessState: "advanced" },
        { ...noopRun("r1", 40), livenessState: "advanced" },
      ],
      ...commentOnlyProgress(["r2", "r1"]),
      hasNewIssueInputSinceLastRun: false,
    });
    // Newest run's productive comment breaks the streak immediately.
    expect(decision).toEqual({ blocked: false, noProgressStreak: 0 });
  });

  it("still allows when a no-op-liveness run left substantive progress", () => {
    const decision = evaluateIssueRewakeThrottle({
      now: NOW,
      recentTerminalRuns: [noopRun("r2", 10), noopRun("r1", 40)],
      runIdsWithIssueProgress: new Set(["r2", "r1"]),
      // r2 also wrote a document: strong progress breaks the streak.
      runIdsWithStrongProgress: new Set(["r2"]),
      hasNewIssueInputSinceLastRun: false,
    });
    expect(decision).toEqual({ blocked: false, noProgressStreak: 0 });
  });

  it("treats a comment-only run with null liveness (pre-liveness DB row) as progress", () => {
    const decision = evaluateIssueRewakeThrottle({
      now: NOW,
      recentTerminalRuns: [
        { ...noopRun("r2", 10), livenessState: null },
        { ...noopRun("r1", 40), livenessState: null },
      ],
      runIdsWithIssueProgress: new Set(["r2", "r1"]),
      runIdsWithStrongProgress: new Set<string>(),
      hasNewIssueInputSinceLastRun: false,
    });
    expect(decision).toEqual({ blocked: false, noProgressStreak: 0 });
  });

  it("preserves legacy behaviour when liveness and strong progress are absent", () => {
    const decision = evaluateIssueRewakeThrottle({
      now: NOW,
      recentTerminalRuns: [
        runSample({ id: "r2", finishedSecondsAgo: 10 }),
        runSample({ id: "r1", finishedSecondsAgo: 40 }),
      ],
      runIdsWithIssueProgress: new Set(["r2", "r1"]),
      hasNewIssueInputSinceLastRun: false,
    });
    expect(decision).toEqual({ blocked: false, noProgressStreak: 0 });
  });
});
