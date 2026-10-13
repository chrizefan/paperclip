import type { Db } from "@paperclipai/db";

import { secretDetected } from "../errors.js";
import { instanceSettingsService } from "./instance-settings.js";
import { detectSecretInFields } from "./secret-detection.js";

/**
 * Refuse a secret before it is persisted, for every persisted writer.
 *
 * DIG-3344 added this guard on `addComment`, the single choke point every
 * issue-comment writer passes through. This is the same guard for the other
 * persisted surfaces: issue-thread interactions, issue documents and work
 * products. Each of those has one service method per write path, and the
 * method guards its own fields before the first insert.
 *
 * Contract, identical to the comment guard:
 * - gated on the instance experimental flag `enableSecretWriteDetection`
 *   (default on), read through `instanceSettingsService`;
 * - refuses with `SecretDetectedError` -> HTTP 422
 *   `{ error: "secret_detected", rule, fingerprint }`;
 * - the refusal carries the rule name and a salted fingerprint only. No part of
 *   the matched value, and no substring of it, reaches the response or a log.
 *
 * `fields` must be the exact values the caller is about to store. Pass the
 * free-text fields of the write; nested objects and arrays are JSON-encoded and
 * scanned as the bytes the jsonb column will hold.
 */
export async function assertNoSecretWrite(db: Db, fields: readonly unknown[]): Promise<void> {
  const experimentalSettings = await instanceSettingsService(db).getExperimental();
  if (!experimentalSettings.enableSecretWriteDetection) return;
  const secret = detectSecretInFields(fields);
  if (secret) throw secretDetected(secret.rule, secret.fingerprint);
}