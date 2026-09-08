export function failure(name: string, message: string): Error {
  return Object.assign(new Error(message), { name });
}

export function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? failure("RunAbortedError", "Run aborted");
}
