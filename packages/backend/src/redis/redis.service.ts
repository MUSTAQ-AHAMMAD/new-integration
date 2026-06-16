import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis, { RedisOptions } from 'ioredis';

function resolveRedisOptions(config: ConfigService): RedisOptions {
  const sentinelHosts = config.get<string>('REDIS_SENTINEL_HOSTS');
  const masterName = config.get<string>('REDIS_MASTER_NAME', 'mymaster');
  const password = config.get<string>('REDIS_PASSWORD') || undefined;

  if (sentinelHosts) {
    const sentinels = sentinelHosts.split(',').map((entry) => {
      const [host, port] = entry.trim().split(':');
      return { host, port: Number(port) || 26379 };
    });
    return {
      sentinels,
      name: masterName,
      password,
      sentinelPassword: password,
      retryStrategy: (times: number) => Math.min(times * 100, 5000),
      lazyConnect: true,
      maxRetriesPerRequest: null,
    };
  }

  return {
    host: config.get('REDIS_HOST', 'localhost'),
    port: config.get<number>('REDIS_PORT', 6379),
    password,
    retryStrategy: (times: number) => Math.min(times * 100, 5000),
    lazyConnect: true,
    maxRetriesPerRequest: null,
  };
}

@Injectable()
export class RedisService extends Redis implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);

  // configService is intentionally not a parameter property so that
  // super() can be called unconditionally at the root of the constructor.
  constructor(configService: ConfigService) {
    super(resolveRedisOptions(configService));

    void this.connect().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Redis initial connection failed: ${message}`);
    });
    this.on('connect', () => this.logger.log('Redis connected'));
    this.on('error', (err: Error) =>
      this.logger.error(`Redis error: ${err.message}`),
    );
  }

  async onModuleDestroy() {
    await this.quit();
  }
}
