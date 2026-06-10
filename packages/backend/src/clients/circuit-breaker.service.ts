import {
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { RedisService } from '../redis/redis.service';

export enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  recoveryTimeout?: number;
  halfOpenRequests?: number;
}

interface CircuitSnapshot {
  name: string;
  state: CircuitState;
  failureCount: number;
  failureThreshold: number;
  recoveryTimeout: number;
  halfOpenRequests: number;
  halfOpenInFlight: number;
  halfOpenCompleted: number;
  openedAt?: number;
  lastFailureAt?: number;
}

interface CircuitStatus {
  name: string;
  state: CircuitState;
  failureCount: number;
  failureThreshold: number;
  recoveryTimeout: number;
  halfOpenRequests: number;
  halfOpenInFlight: number;
  halfOpenCompleted: number;
  openedAt?: string;
  lastFailureAt?: string;
}

const DEFAULT_OPTIONS: Required<CircuitBreakerOptions> = {
  failureThreshold: 10,
  recoveryTimeout: 60_000,
  halfOpenRequests: 1,
};

const KEY_PREFIX = 'circuit_breaker';
const TTL_SECONDS = 300; // auto-expire idle circuits after 5 minutes

@Injectable()
export class CircuitBreakerService {
  private readonly logger = new Logger(CircuitBreakerService.name);
  // In-memory fallback when Redis is unavailable
  private readonly localFallback = new Map<string, CircuitSnapshot>();

  // redis defaults to undefined so that `new CircuitBreakerService()` compiles
  // in unit tests and inline fallbacks; NestJS DI will inject the real instance.
  constructor(
    @Optional() private readonly redis: RedisService | undefined = undefined,
  ) {}

  async execute<T>(
    name: string,
    fn: () => Promise<T>,
    options?: CircuitBreakerOptions,
  ): Promise<T> {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const now = Date.now();
    const snap = await this.readCircuit(name, opts);

    if (snap.state === CircuitState.OPEN) {
      const openedAt = snap.openedAt ?? now;
      if (now - openedAt < snap.recoveryTimeout) {
        throw new ServiceUnavailableException(
          `Circuit ${name} is open and recovering`,
        );
      }
      // Transition to HALF_OPEN
      await this.writeField(name, 'state', CircuitState.HALF_OPEN);
      await this.writeField(name, 'halfOpenInFlight', '0');
      await this.writeField(name, 'halfOpenCompleted', '0');
      snap.state = CircuitState.HALF_OPEN;
      snap.halfOpenInFlight = 0;
      snap.halfOpenCompleted = 0;
      this.logger.warn(`Circuit ${name} moved to HALF_OPEN`);
    }

    if (
      snap.state === CircuitState.HALF_OPEN &&
      snap.halfOpenInFlight >= snap.halfOpenRequests
    ) {
      throw new ServiceUnavailableException(
        `Circuit ${name} is half-open and busy`,
      );
    }

    if (snap.state === CircuitState.HALF_OPEN) {
      await this.incrField(name, 'halfOpenInFlight');
    }

    try {
      const result = await fn();

      if (snap.state === CircuitState.HALF_OPEN) {
        await this.incrField(name, 'halfOpenInFlight', -1);
        const completed = await this.incrField(name, 'halfOpenCompleted');
        if (completed >= snap.halfOpenRequests) {
          await this.closeCircuit(name);
          this.logger.log(`Circuit ${name} closed after recovery`);
        }
      } else {
        await this.writeField(name, 'failureCount', '0');
        await this.writeField(name, 'lastFailureAt', '0');
      }

      return result;
    } catch (error: unknown) {
      if (snap.state === CircuitState.HALF_OPEN) {
        await this.incrField(name, 'halfOpenInFlight', -1);
      }

      const failures = await this.incrField(name, 'failureCount');
      await this.writeField(name, 'lastFailureAt', String(Date.now()));

      if (
        snap.state === CircuitState.HALF_OPEN ||
        failures >= snap.failureThreshold
      ) {
        await this.writeField(name, 'state', CircuitState.OPEN);
        await this.writeField(name, 'openedAt', String(Date.now()));
        await this.writeField(name, 'halfOpenInFlight', '0');
        await this.writeField(name, 'halfOpenCompleted', '0');
        this.logger.warn(`Circuit ${name} opened after failure`);
      }

      throw error;
    }
  }

  async getStatus(name?: string): Promise<CircuitStatus | CircuitStatus[] | null> {
    if (name) {
      const exists = await this.circuitExists(name);
      if (!exists) return null;
      const snap = await this.readCircuit(name, DEFAULT_OPTIONS);
      return this.toStatus(snap);
    }
    const keys = await this.keys(`${KEY_PREFIX}:*`);
    const statuses = await Promise.all(
      keys.map(async (k) => {
        const n = k.replace(`${KEY_PREFIX}:`, '');
        const snap = await this.readCircuit(n, DEFAULT_OPTIONS);
        return this.toStatus(snap);
      }),
    );
    return statuses;
  }

  // ── Private helpers ──────────────────────────────────────────────

  private async circuitExists(name: string): Promise<boolean> {
    try {
      if (this.redis) {
        return (await this.redis.exists(`${KEY_PREFIX}:${name}`)) === 1;
      }
    } catch {
      // fall through
    }
    return this.localFallback.has(name);
  }

  private async readCircuit(
    name: string,
    opts: Required<CircuitBreakerOptions>,
  ): Promise<CircuitSnapshot> {
    try {
      if (this.redis) {
        const raw = await this.redis.hgetall(`${KEY_PREFIX}:${name}`);
        return {
          name,
          state: (raw.state as CircuitState) ?? CircuitState.CLOSED,
          failureCount: Number(raw.failureCount ?? 0),
          failureThreshold: opts.failureThreshold,
          recoveryTimeout: opts.recoveryTimeout,
          halfOpenRequests: opts.halfOpenRequests,
          halfOpenInFlight: Number(raw.halfOpenInFlight ?? 0),
          halfOpenCompleted: Number(raw.halfOpenCompleted ?? 0),
          openedAt: raw.openedAt ? Number(raw.openedAt) : undefined,
          lastFailureAt: raw.lastFailureAt ? Number(raw.lastFailureAt) : undefined,
        };
      }
    } catch (err) {
      this.logger.warn(`Redis unavailable for circuit ${name}, using local fallback`);
    }
    return {
      ...(this.localFallback.get(name) ?? this.emptySnapshot(name)),
      // Always apply current opts so per-call options (e.g. recoveryTimeout)
      // are respected, mirroring the behaviour of the Redis path above.
      failureThreshold: opts.failureThreshold,
      recoveryTimeout: opts.recoveryTimeout,
      halfOpenRequests: opts.halfOpenRequests,
    };
  }

  private async writeField(name: string, field: string, value: string): Promise<void> {
    const key = `${KEY_PREFIX}:${name}`;
    try {
      if (this.redis) {
        await this.redis.hset(key, field, value);
        await this.redis.expire(key, TTL_SECONDS);
        return;
      }
    } catch {
      // fall through to local fallback
    }
    const snap = this.localFallback.get(name) ?? this.emptySnapshot(name);
    // Coerce numeric strings to numbers so Date(openedAt) works correctly.
    const parsed =
      value !== '' && !isNaN(Number(value)) ? Number(value) : value;
    (snap as unknown as Record<string, unknown>)[field] = parsed;
    this.localFallback.set(name, snap);
  }

  private async incrField(name: string, field: string, by = 1): Promise<number> {
    const key = `${KEY_PREFIX}:${name}`;
    try {
      if (this.redis) {
        const result = await this.redis.hincrby(key, field, by);
        await this.redis.expire(key, TTL_SECONDS);
        return result;
      }
    } catch {
      // fall through to local fallback
    }
    const snap = this.localFallback.get(name) ?? this.emptySnapshot(name);
    const current = Number((snap as unknown as Record<string, unknown>)[field] ?? 0);
    const updated = current + by;
    (snap as unknown as Record<string, unknown>)[field] = updated;
    this.localFallback.set(name, snap);
    return updated;
  }

  private async closeCircuit(name: string): Promise<void> {
    const key = `${KEY_PREFIX}:${name}`;
    try {
      if (this.redis) {
        await this.redis.hmset(key, {
          state: CircuitState.CLOSED,
          failureCount: '0',
          openedAt: '0',
          lastFailureAt: '0',
          halfOpenInFlight: '0',
          halfOpenCompleted: '0',
        });
        await this.redis.expire(key, TTL_SECONDS);
        return;
      }
    } catch {
      // fall through to local fallback
    }
    // Reset to CLOSED state; keep the entry so getStatus still shows it.
    const snap = this.localFallback.get(name) ?? this.emptySnapshot(name);
    snap.state = CircuitState.CLOSED;
    snap.failureCount = 0;
    snap.openedAt = undefined;
    snap.lastFailureAt = undefined;
    snap.halfOpenInFlight = 0;
    snap.halfOpenCompleted = 0;
    this.localFallback.set(name, snap);
  }

  private async keys(pattern: string): Promise<string[]> {
    try {
      if (this.redis) {
        // Use SCAN instead of KEYS to avoid blocking the Redis instance on large keyspaces.
        const results: string[] = [];
        let cursor = '0';
        do {
          const [nextCursor, batch] = await this.redis.scan(
            cursor,
            'MATCH',
            pattern,
            'COUNT',
            100,
          );
          cursor = nextCursor;
          results.push(...batch);
        } while (cursor !== '0');
        return results;
      }
    } catch {
      // ignore
    }
    return Array.from(this.localFallback.keys()).map((n) => `${KEY_PREFIX}:${n}`);
  }

  private emptySnapshot(name: string): CircuitSnapshot {
    return {
      name,
      state: CircuitState.CLOSED,
      failureCount: 0,
      failureThreshold: DEFAULT_OPTIONS.failureThreshold,
      recoveryTimeout: DEFAULT_OPTIONS.recoveryTimeout,
      halfOpenRequests: DEFAULT_OPTIONS.halfOpenRequests,
      halfOpenInFlight: 0,
      halfOpenCompleted: 0,
    };
  }

  private toStatus(snap: CircuitSnapshot): CircuitStatus {
    return {
      name: snap.name,
      state: snap.state,
      failureCount: snap.failureCount,
      failureThreshold: snap.failureThreshold,
      recoveryTimeout: snap.recoveryTimeout,
      halfOpenRequests: snap.halfOpenRequests,
      halfOpenInFlight: snap.halfOpenInFlight,
      halfOpenCompleted: snap.halfOpenCompleted,
      openedAt:
        snap.openedAt && snap.openedAt > 0
          ? new Date(snap.openedAt).toISOString()
          : undefined,
      lastFailureAt:
        snap.lastFailureAt && snap.lastFailureAt > 0
          ? new Date(snap.lastFailureAt).toISOString()
          : undefined,
    };
  }
}
