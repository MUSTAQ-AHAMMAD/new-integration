import { CircuitBreakerService, CircuitState } from './circuit-breaker.service';

describe('CircuitBreakerService', () => {
  let service: CircuitBreakerService;

  beforeEach(() => {
    service = new CircuitBreakerService();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('execute – CLOSED state', () => {
    it('executes the function and returns its result', async () => {
      const fn = jest.fn().mockResolvedValue('ok');

      const result = await service.execute('test', fn);

      expect(result).toBe('ok');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('propagates errors from the wrapped function', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('network error'));

      await expect(service.execute('test', fn)).rejects.toThrow('network error');
    });
  });

  describe('circuit opening after threshold failures', () => {
    it('opens the circuit after reaching the failure threshold', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('fail'));

      for (let i = 0; i < 5; i++) {
        await service.execute('broken', fn).catch(() => undefined);
      }

      const status = service.getStatus('broken') as { state: string } | null;
      expect(status).not.toBeNull();
      expect(status?.state).toBe(CircuitState.OPEN);
    });

    it('blocks requests when circuit is OPEN', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('fail'));

      for (let i = 0; i < 5; i++) {
        await service.execute('blocked', fn).catch(() => undefined);
      }

      const fn2 = jest.fn().mockResolvedValue('should not run');
      await expect(service.execute('blocked', fn2)).rejects.toThrow();
      expect(fn2).not.toHaveBeenCalled();
    });
  });

  describe('HALF_OPEN recovery', () => {
    it('transitions to HALF_OPEN and then CLOSED after successful probe', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('fail'));

      for (let i = 0; i < 5; i++) {
        await service.execute('recover', fn, { recoveryTimeout: 1000 }).catch(() => undefined);
      }

      // Advance time past recovery timeout
      jest.advanceTimersByTime(1100);

      const successFn = jest.fn().mockResolvedValue('recovered');
      const result = await service.execute('recover', successFn, { recoveryTimeout: 1000 });

      expect(result).toBe('recovered');
      const status = service.getStatus('recover') as { state: string } | null;
      expect(status?.state).toBe(CircuitState.CLOSED);
    });
  });

  describe('getStatus', () => {
    it('returns null for an unknown circuit by name', () => {
      const status = service.getStatus('unknown-circuit');
      expect(status).toBeNull();
    });

    it('returns an array of all circuits when no name provided', async () => {
      await service.execute('circuit-a', jest.fn().mockResolvedValue('a'));
      await service.execute('circuit-b', jest.fn().mockResolvedValue('b'));

      const status = service.getStatus() as unknown[];

      expect(Array.isArray(status)).toBe(true);
      expect(status.length).toBeGreaterThanOrEqual(2);
    });

    it('returns a single status object for a named circuit', async () => {
      await service.execute('specific', jest.fn().mockResolvedValue('x'));

      const status = service.getStatus('specific') as { name: string; state: string } | null;

      expect(status).not.toBeNull();
      expect(status?.name).toBe('specific');
      expect(status?.state).toBe(CircuitState.CLOSED);
    });
  });
});
