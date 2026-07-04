/**
 * Timeout utilities for protecting async operations
 */

/**
 * Wraps a promise with a timeout. If the promise doesn't resolve within
 * the specified timeout, returns a rejected promise with a timeout error.
 *
 * @param promise - The promise to wrap with a timeout
 * @param timeoutMs - Timeout in milliseconds
 * @param operationName - Name of the operation for error messages
 * @returns The result of the promise if it completes in time
 * @throws Error if the timeout is exceeded
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operationName = 'Operation',
): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`${operationName} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([promise, timeoutPromise]);
    if (timeoutHandle) clearTimeout(timeoutHandle);
    return result;
  } catch (err) {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    throw err;
  }
}

/**
 * Default timeout for onModuleInit lifecycle hooks (30 seconds)
 */
export const MODULE_INIT_TIMEOUT_MS = 30_000;
