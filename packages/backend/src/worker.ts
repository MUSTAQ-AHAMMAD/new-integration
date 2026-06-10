/**
 * Worker process entrypoint.
 *
 * Starts a NestJS application context (no HTTP server) that registers all
 * BullMQ queue processors.  Deploy this as a separate service alongside the
 * API server to independently scale queue-processing capacity.
 *
 * Usage:
 *   Production: node dist/worker
 *   Development: pnpm run start:worker:dev
 */
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { WorkerAppModule } from './worker-app.module';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerAppModule, {
    bufferLogs: true,
  });

  app.useLogger(app.get(Logger));
  app
    .get(Logger)
    .log('🔧 BullMQ worker process started — processing queues…');

  // Keep the process alive; BullMQ processors are event-driven.
  // The application context stays open as long as there are active listeners.
}

void bootstrap();
