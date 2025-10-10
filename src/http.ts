export type FetchOptions = RequestInit;

export async function fetchWithTimeout(
  input: RequestInfo,
  options: FetchOptions = {},
  timeoutMs = 10000,
): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(input, { ...options, signal: controller.signal });
    return resp;
  } finally {
    clearTimeout(id);
  }
}

export interface RetryOptions {
  retries?: number;
  timeoutMs?: number;
  backoffMs?: number; // base backoff
}

export async function fetchWithRetry(
  input: RequestInfo,
  options: FetchOptions = {},
  { retries = 2, timeoutMs = 10000, backoffMs = 500 }: RetryOptions = {},
): Promise<Response> {
  // retries: number of additional attempts after the first try.
  const maxAttempts = retries + 1;
  let attempt = 0;
  let lastErr: unknown = null;
  while (attempt < maxAttempts) {
    try {
      const resp = await fetchWithTimeout(input, options, timeoutMs);
      return resp;
    } catch (e) {
      lastErr = e;
      attempt += 1;
      // If there are more attempts remaining, wait with backoff before retrying.
      if (attempt < maxAttempts) {
        const waitMs = backoffMs * attempt;
        await new Promise((res) => setTimeout(res, waitMs));
      }
    }
  }
  throw lastErr;
}
