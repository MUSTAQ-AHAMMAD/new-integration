import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import {
  withTimeout,
  MODULE_INIT_TIMEOUT_MS,
} from '../common/utils/timeout';

/** Queries slower than this threshold are logged as warnings. */
const SLOW_QUERY_THRESHOLD_MS = 1_000;

/** Minimal type for Prisma query events (compatible across Prisma v5/v6). */
interface PrismaQueryEvent {
  query: string;
  duration: number;
  params?: string;
  target?: string;
}

/** Minimal type for Prisma warn/error log events. */
interface PrismaLogEvent {
  message: string;
  target?: string;
}

/** Intersection used to access the $on overloads that accept log-level strings. */
type PrismaWithEvents = PrismaClient & {
  $on(event: 'query', fn: (event: PrismaQueryEvent) => void): void;
  $on(event: 'warn' | 'error', fn: (event: PrismaLogEvent) => void): void;
};

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({
      log:
        process.env.NODE_ENV !== 'production'
          ? [
              { emit: 'event', level: 'query' },
              { emit: 'event', level: 'warn' },
              { emit: 'event', level: 'error' },
            ]
          : [
              { emit: 'event', level: 'warn' },
              { emit: 'event', level: 'error' },
            ],
    });

    const self = this as unknown as PrismaWithEvents;

    if (process.env.NODE_ENV !== 'production') {
      // Log slow queries as warnings so they surface in Grafana / log aggregation.
      self.$on('query', (event: PrismaQueryEvent) => {
        if (event.duration >= SLOW_QUERY_THRESHOLD_MS) {
          this.logger.warn(`Slow query (${event.duration}ms): ${event.query}`);
        }
      });
    }

    self.$on('warn', (event: PrismaLogEvent) => {
      this.logger.warn(event.message);
    });

    self.$on('error', (event: PrismaLogEvent) => {
      this.logger.error(event.message);
    });
  }

  async onModuleInit() {
    await withTimeout(
      this.$connect(),
      MODULE_INIT_TIMEOUT_MS,
      'PrismaService.onModuleInit',
    );
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
