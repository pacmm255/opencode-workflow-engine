/** Sanitized recovery data. Never persist provider response bodies, headers, or credentials. */
export type ExecutionFailure = {
  kind: "quota" | "rate_limit" | "permission" | "authentication" | "configuration" | "output_limit" | "transient";
  message: string;
  statusCode?: number;
  retryAt?: number;
};

export function executionFailure(error: unknown, now = Date.now()): ExecutionFailure | undefined {
  if (!error) return;
  const value = typeof error === "object" ? error as Record<string, any> : { message: String(error) };
  if (value.cause) {
    const cause = executionFailure(value.cause, now);
    if (cause) return cause;
  }
  const data = value.data ?? value;
  let body: Record<string, any> = {};
  try { body = JSON.parse(data.responseBody ?? "{}").error ?? {}; } catch { /* Non-JSON provider response. */ }
  const message = String(data.message ?? value.message ?? body.message ?? value.name ?? "Agent failed").slice(0, 2000);
  const code = Number(data.statusCode);
  const text = `${value.name ?? ""} ${body.type ?? ""} ${body.code ?? ""} ${message}`;
  const kind: ExecutionFailure["kind"] | undefined = /usage_limit_reached|insufficient_quota|quota.{0,40}(?:exceed|exhaust)|usage limit/i.test(text) ? "quota"
    : code === 429 || /rate.?limit/i.test(text) ? "rate_limit"
    : /permission.{0,80}(?:denied|reject)|(?:denied|reject).{0,80}permission|authorization required/i.test(text) ? "permission"
    : code === 401 || /ProviderAuthError|invalid.api.key|authentication/i.test(text) ? "authentication"
    : /(?:agent|model|provider).{0,60}(?:not found|unknown|unavailable|not configured)|AgentConfigurationError/i.test(text)
      || code === 400 && /unsupported parameter|unknown parameter|unrecognized parameter/i.test(text) ? "configuration"
    : /OutputLimit|(?:output|context).{0,30}(?:length|limit)|finish.length/i.test(text) ? "output_limit"
    : code >= 500 && code < 600 ? "transient" : undefined;
  if (!kind) return;
  const times: number[] = [];
  const seconds = Number(body.resets_in_seconds);
  const epoch = Number(body.resets_at);
  if (Number.isFinite(seconds) && seconds > 0) times.push(now + seconds * 1000);
  if (Number.isFinite(epoch) && epoch > 0) times.push(epoch * 1000);
  const header = data.responseHeaders?.["retry-after"] ?? data.responseHeaders?.["Retry-After"];
  if (header !== undefined) {
    const after = Number(header);
    times.push(Number.isFinite(after) ? now + Math.max(0, after) * 1000 : Date.parse(String(header)));
  }
  const retryAt = Math.max(0, ...times.filter(time => Number.isFinite(time) && time > now && time <= Number.MAX_SAFE_INTEGER));
  return { kind, message, ...(Number.isInteger(code) && code > 0 ? { statusCode: code } : {}), ...(retryAt ? { retryAt } : {}) };
}
