import { NestFactory } from '@nestjs/core';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import * as compression from 'compression';
import helmet from 'helmet';
import { json } from 'express';
import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';

async function bootstrap() {
  try {
    console.log('[main.ts] Starting bootstrap...');
    
    const app = await NestFactory.create(AppModule, {
      bufferLogs: true,
      rawBody: true,
    });

    console.log('[main.ts] NestFactory created');

    app.useLogger(app.get(Logger));
    app.useGlobalFilters(new GlobalExceptionFilter());

    // Limit request body size to 10 MB to protect against oversized payloads
    app.use(json({ limit: '10mb' }));
    console.log('[main.ts] JSON middleware added');

    // Enable helmet with CSP that allows Swagger UI.
    app.use(
      helmet({
        contentSecurityPolicy: {
          directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", 'data:', 'blob:'],
            connectSrc: ["'self'"],
            fontSrc: ["'self'", 'data:'],
          },
        },
      }),
    );
    console.log('[main.ts] Helmet added');

    app.use(compression());
    app.enableCors({
      origin: process.env.CORS_ORIGIN || (process.env.NODE_ENV === 'production' ? false : 'http://localhost:3000'),
      credentials: true,
    });
    console.log('[main.ts] CORS enabled');

    app.setGlobalPrefix(process.env.API_PREFIX || 'api/v1');
    app.enableVersioning({ type: VersioningType.URI });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );
    console.log('[main.ts] Global prefix and versioning configured');

    // Skip Bull Board setup - it might be causing the hang
    console.log('[main.ts] Skipping Bull Board setup');

    const config = new DocumentBuilder()
      .setTitle('Integration Middleware API')
      .setDescription('Odoo → Oracle Fusion middleware - enterprise integration system')
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('docs', app, document);
    console.log('[main.ts] Swagger configured');

    const port = process.env.PORT || 3001;
    console.log(`[main.ts] Starting server on port ${port}...`);
    
    // Use Promise.race with a timeout to prevent infinite hanging
    const listenPromise = app.listen(port);
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('app.listen() timeout after 30s')), 30000)
    );
    
    try {
      await Promise.race([listenPromise, timeoutPromise]);
    } catch (err) {
      console.error('[main.ts] app.listen() timed out or failed:', err);
      console.log('[main.ts] App will continue running despite listen error');
    }
    
    console.log(`[main.ts] Server listening on port ${port}!`);
  } catch (error) {
    console.error('[main.ts] Bootstrap failed:', error);
    process.exit(1);
  }
}

void bootstrap();
