export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry<T>(
  operation: string,
  fn: () => Promise<T>,
  options?: { attempts?: number; isRetryable?: (error: unknown) => boolean },
): Promise<T> {
  const attempts = options?.attempts ?? 3;
  const isRetryable = options?.isRetryable ?? (() => false);
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !isRetryable(error)) throw error;
      await sleep(Math.min(1000 * 2 ** (attempt - 1), 5000));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`${operation} failed`);
}
