export class HttpError extends Error {
  status: number;
  details?: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export function badRequest(message: string, details?: unknown) {
  return new HttpError(400, message, details);
}

export function unauthorized(message = "Unauthorized") {
  return new HttpError(401, message);
}

export function forbidden(message = "Forbidden", details?: unknown) {
  return new HttpError(403, message, details);
}

export function notFound(message = "Not found", details?: unknown) {
  return new HttpError(404, message, details);
}

export function conflict(message: string, details?: unknown) {
  return new HttpError(409, message, details);
}

export function payloadTooLarge(message: string, details?: unknown) {
  return new HttpError(413, message, details);
}

export function unsupportedMediaType(message: string, details?: unknown) {
  return new HttpError(415, message, details);
}

export function unprocessable(message: string, details?: unknown) {
  return new HttpError(422, message, details);
}

export function tooManyRequests(message = "Too many requests", details?: unknown) {
  return new HttpError(429, message, details);
}

/**
 * Refusal for a write that carries a secret value. The response body names the
 * matching rule and carries only a salted fingerprint — never the value, or any
 * substring of it. The dedicated error-handler branch renders the exact shape
 * `{ error: "secret_detected", rule, fingerprint }`.
 */
export class SecretDetectedError extends HttpError {
  readonly rule: string;
  readonly fingerprint: string;

  constructor(rule: string, fingerprint: string) {
    super(422, "secret_detected", { code: "secret_detected", rule, fingerprint });
    this.name = "SecretDetectedError";
    this.rule = rule;
    this.fingerprint = fingerprint;
  }
}

export function secretDetected(rule: string, fingerprint: string) {
  return new SecretDetectedError(rule, fingerprint);
}
