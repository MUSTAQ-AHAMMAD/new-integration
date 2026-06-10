import { NestFactory } from '@nestjs/core';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import * as compression from 'compression';
import helmet from 'helmet';
import { json } from 'express';
import { createBullBoard } from '@bull-board/api';
import { BullAdapter } from '@bull-board/api/bullAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { getQueueToken } from '@nestjs/bull';
import { Queue } from 'bull';
import { AppModule } from './app.module';
import { QUEUE_NAMES } from './queues/queues.module';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
    rawBody: true,
  });

  app.useLogger(app.get(Logger));
  app.useGlobalFilters(new GlobalExceptionFilter());
  // Limit request body size to 10 MB to protect against oversized payloads
  app.use(json({ limit: '10mb' }));
  // Enable helmet with a relaxed CSP that still allows the Swagger UI to function
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'blob:'],
          connectSrc: ["'self'"],
          fontSrc: ["'self'", 'data:'],
        },
      },
    }),
  );
  app.use(compression());
  app.enableCors({ origin: process.env.CORS_ORIGIN || '*', credentials: true });
  app.setGlobalPrefix(process.env.API_PREFIX || 'api/v1');
  app.enableVersioning({ type: VersioningType.URI });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  // Bull Board queue administration UI
  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath('/queues');
  createBullBoard({
    queues: Object.values(QUEUE_NAMES).map(
      (name) => new BullAdapter(app.get<Queue>(getQueueToken(name))),
    ),
    serverAdapter,
  });
  app.use('/queues', serverAdapter.getRouter());

  const config = new DocumentBuilder()
    .setTitle('Integration Middleware API')
    .setDescription(
      'Odoo → Oracle Fusion middleware - enterprise integration system',
    )
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document);

  const port = process.env.PORT || 3001;
  await app.listen(port);
  app.get(Logger).log(`🚀 Application running on port ${port}`);
  app
    .get(Logger)
    .log(`📊 Bull Board available at http://localhost:${port}/queues`);
}
void bootstrap();
