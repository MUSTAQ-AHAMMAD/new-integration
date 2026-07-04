import { withTimeout, MODULE_INIT_TIMEOUT_MS } from './timeout';

describe('withTimeout', () => {
  beforeEach(() => {
    jest.clearAllTimers();
  });

  it('should resolve when promise completes before timeout', async () => {
    const promise = Promise.resolve('success');
    const result = await withTimeout(promise, 1000, 'TestOperation');
    expect(result).toBe('success');
  });

  it('should reject when promise times out', async () => {
    const promise = new Promise((resolve) => {
      setTimeout(() => resolve('too late'), 2000);
    });

    await expect(
      withTimeout(promise, 100, 'TestOperation'),
    ).rejects.toThrow('TestOperation timed out after 100ms');
  });

  it('should propagate errors from the original promise', async () => {
    const error = new Error('Original error');
    const promise = Promise.reject(error);

    await expect(withTimeout(promise, 1000, 'TestOperation')).rejects.toThrow(
      'Original error',
    );
  });

  it('should use default operation name when not provided', async () => {
    const promise = new Promise((resolve) => {
      setTimeout(() => resolve('too late'), 2000);
    });

    await expect(withTimeout(promise, 100)).rejects.toThrow(
      'Operation timed out after 100ms',
    );
  });

  it('should clear timeout when promise resolves', async () => {
    const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');
    const promise = Promise.resolve('success');

    await withTimeout(promise, 1000, 'TestOperation');

    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });

  it('should clear timeout when promise rejects', async () => {
    const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');
    const promise = Promise.reject(new Error('test error'));

    try {
      await withTimeout(promise, 1000, 'TestOperation');
    } catch (err) {
      // Expected
    }

    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });

  it('should handle concurrent withTimeout calls independently', async () => {
    const promise1 = new Promise((resolve) =>
      setTimeout(() => resolve('first'), 50),
    );
    const promise2 = new Promise((resolve) =>
      setTimeout(() => resolve('second'), 100),
    );

    const [result1, result2] = await Promise.all([
      withTimeout(promise1, 1000, 'First'),
      withTimeout(promise2, 1000, 'Second'),
    ]);

    expect(result1).toBe('first');
    expect(result2).toBe('second');
  });
});

describe('MODULE_INIT_TIMEOUT_MS', () => {
  it('should be set to 30 seconds', () => {
    expect(MODULE_INIT_TIMEOUT_MS).toBe(30_000);
  });
});
