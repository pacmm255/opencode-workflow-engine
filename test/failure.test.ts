import { expect, test } from "bun:test";
import { executionFailure } from "../src/core/run/failure";

test("provider quota failures retain reset metadata without retaining raw responses", () => {
  const now = Date.UTC(2026, 8, 10, 20, 52);
  const reset = Date.UTC(2026, 8, 10, 22, 4, 22);
  const original = { name: "APIError", data: { message: "The usage limit has been reached", statusCode: 429,
    responseBody: JSON.stringify({ error: { type: "usage_limit_reached", resets_at: reset / 1000 } }),
    responseHeaders: { authorization: "must-not-survive", "set-cookie": "must-not-survive" } } };
  const result = executionFailure(new Error("wrapped", { cause: original }), now);
  expect(result).toEqual({ kind: "quota", message: "The usage limit has been reached", statusCode: 429, retryAt: reset });
  expect(JSON.stringify(result)).not.toContain("must-not-survive");
});

test("relative quota resets and both Retry-After formats are honored", () => {
  const now = Date.UTC(2026, 8, 11);
  expect(executionFailure({ data: { message: "usage limit", responseBody: '{"error":{"resets_in_seconds":3600}}' } }, now)?.retryAt).toBe(now + 3_600_000);
  expect(executionFailure({ data: { statusCode: 429, message: "rate limit", responseHeaders: { "retry-after": "120" } } }, now)?.retryAt).toBe(now + 120_000);
  expect(executionFailure({ data: { statusCode: 429, message: "rate limit", responseHeaders: { "Retry-After": new Date(now + 600_000).toUTCString() } } }, now)?.retryAt).toBe(now + 600_000);
});

test("nonrecoverable permission/authentication and transient server errors stay distinct", () => {
  expect(executionFailure({ name: "APIError", data: { statusCode: 400,
    message: 'Bad Request: {"detail":"Unsupported parameter: max_output_tokens"}' } })?.kind).toBe("configuration");
  expect(executionFailure("Permission denied by the user")?.kind).toBe("permission");
  expect(executionFailure({ data: { statusCode: 401, message: "Invalid API key" } })?.kind).toBe("authentication");
  expect(executionFailure({ data: { statusCode: 503, message: "Unavailable" } })?.kind).toBe("transient");
  expect(executionFailure("The requested test failed")).toBeUndefined();
});
