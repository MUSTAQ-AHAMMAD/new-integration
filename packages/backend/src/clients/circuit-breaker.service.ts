import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';

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

interface CircuitRecord {
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
  failureThreshold: 5,
  recoveryTimeout: 30_000,
  halfOpenRequests: 1,
};

@Injectable()
export class CircuitBreakerService {
  private readonly logger = new Logger(CircuitBreakerService.name);
  private readonly circuits = new Map<string, CircuitRecord>();

  async execute<T>(
    name: string,
    fn: () => Promise<T>,
    options?: CircuitBreakerOptions,
  ): Promise<T> {
    const circuit = this.getCircuit(name, options);
    const now = Date.now();

    if (circuit.state === CircuitState.OPEN) {
      const openedAt = circuit.openedAt ?? now;
      if (now - openedAt < circuit.recoveryTimeout) {
        throw new ServiceUnavailableException(
          `Circuit ${name} is open and recovering`,
        );
      }

      circuit.state = CircuitState.HALF_OPEN;
      circuit.halfOpenInFlight = 0;
      circuit.halfOpenCompleted = 0;
      this.logger.warn(`Circuit ${name} moved to HALF_OPEN`);
    }

    if (
      circuit.state === CircuitState.HALF_OPEN &&
      circuit.halfOpenInFlight >= circuit.halfOpenRequests
    ) {
      throw new ServiceUnavailableException(
        `Circuit ${name} is half-open and busy`,
      );
    }

    if (circuit.state === CircuitState.HALF_OPEN) {
      circuit.halfOpenInFlight += 1;
    }

    try {
      const result = await fn();

      if (circuit.state === CircuitState.HALF_OPEN) {
        circuit.halfOpenInFlight -= 1;
        circuit.halfOpenCompleted += 1;

        if (circuit.halfOpenCompleted >= circuit.halfOpenRequests) {
          this.closeCircuit(circuit);
          this.logger.log(`Circuit ${name} closed after recovery`);
        }
      } else {
        circuit.failureCount = 0;
        circuit.lastFailureAt = undefined;
      }

      return result;
    } catch (error: unknown) {
      if (circuit.state === CircuitState.HALF_OPEN) {
        circuit.halfOpenInFlight = Math.max(0, circuit.halfOpenInFlight - 1);
      }

      circuit.failureCount += 1;
      circuit.lastFailureAt = Date.now();

      if (
        circuit.state === CircuitState.HALF_OPEN ||
        circuit.failureCount >= circuit.failureThreshold
      ) {
        circuit.state = CircuitState.OPEN;
        circuit.openedAt = Date.now();
        circuit.halfOpenInFlight = 0;
        circuit.halfOpenCompleted = 0;
        this.logger.warn(`Circuit ${name} opened after failure`);
      }

      throw error;
    }
  }

  getStatus(name?: string) {
    if (name) {
      const circuit = this.circuits.get(name);
      return circuit ? this.toStatus(circuit) : null;
    }

    return Array.from(this.circuits.values()).map((circuit) =>
      this.toStatus(circuit),
    );
  }

  private getCircuit(
    name: string,
    options?: CircuitBreakerOptions,
  ): CircuitRecord {
    const normalized = {
      ...DEFAULT_OPTIONS,
      ...options,
    };
    const existing = this.circuits.get(name);

    if (existing) {
      existing.failureThreshold = normalized.failureThreshold;
      existing.recoveryTimeout = normalized.recoveryTimeout;
      existing.halfOpenRequests = normalized.halfOpenRequests;
      return existing;
    }

    const circuit: CircuitRecord = {
      name,
      state: CircuitState.CLOSED,
      failureCount: 0,
      failureThreshold: normalized.failureThreshold,
      recoveryTimeout: normalized.recoveryTimeout,
      halfOpenRequests: normalized.halfOpenRequests,
      halfOpenInFlight: 0,
      halfOpenCompleted: 0,
    };
    this.circuits.set(name, circuit);
    return circuit;
  }

  private closeCircuit(circuit: CircuitRecord) {
    circuit.state = CircuitState.CLOSED;
    circuit.failureCount = 0;
    circuit.openedAt = undefined;
    circuit.lastFailureAt = undefined;
    circuit.halfOpenInFlight = 0;
    circuit.halfOpenCompleted = 0;
  }

  private toStatus(circuit: CircuitRecord): CircuitStatus {
    return {
      name: circuit.name,
      state: circuit.state,
      failureCount: circuit.failureCount,
      failureThreshold: circuit.failureThreshold,
      recoveryTimeout: circuit.recoveryTimeout,
      halfOpenRequests: circuit.halfOpenRequests,
      halfOpenInFlight: circuit.halfOpenInFlight,
      halfOpenCompleted: circuit.halfOpenCompleted,
      openedAt: circuit.openedAt
        ? new Date(circuit.openedAt).toISOString()
        : undefined,
      lastFailureAt: circuit.lastFailureAt
        ? new Date(circuit.lastFailureAt).toISOString()
        : undefined,
    };
  }
}
