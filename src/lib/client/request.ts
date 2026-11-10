/** Every interactive request is bounded; aborted mutations may have committed. */
export async function requestJson<T = Record<string, unknown>>(
  url: string,
  init: RequestInit = {}
): Promise<T> {
  try {
    const response = await fetch(url, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(30000),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || `Request failed (${response.status}).`);
    return body as T;
  } catch (error) {
    if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name))
      throw new Error('Request timed out. The server may still finish. Refresh before retrying.');
    throw error;
  }
}
