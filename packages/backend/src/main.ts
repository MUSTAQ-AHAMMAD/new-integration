import { NestFactory } from '@nestjs/core';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import * as compression from 'compression';
import helmet from 'helmet';
import { json } from 'express';
import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';

// Initialize Oracle Thick Mode BEFORE creating the NestJS application
async function initializeOracleThickMode() {
  if (process.env.ORACLE_DB_THICK_MODE === 'true') {
    console.log('[Oracle] Enabling Thick Mode...');

    try {
      // Dynamic import to avoid loading oracledb if not needed
      const oracledb = await import('oracledb');
      const instantClientDir = process.env.ORACLE_DB_INSTANT_CLIENT_DIR;

      if (instantClientDir) {
        oracledb.initOracleClient({ libDir: instantClientDir });
        console.log(
          `[Oracle] Instant Client initialized from: ${instantClientDir}`,
        );
      } else {
        oracledb.initOracleClient();
        console.log(
          '[Oracle] Instant Client initialized from system library path',
        );
      }

      // Verify Oracle Client version
      console.log(`[Oracle] Node-oracledb version: ${oracledb.versionString}`);
      console.log('[Oracle] Thick Mode enabled successfully');

      // Test connection (optional - remove in production if not needed)
      if (process.env.NODE_ENV !== 'production') {
        try {
          const connection = await oracledb.getConnection({
            user: process.env.ORACLE_DB_USERNAME,
            password: process.env.ORACLE_DB_PASSWORD,
            connectString: `${process.env.ORACLE_DB_HOST}:${process.env.ORACLE_DB_PORT}/${process.env.ORACLE_DB_SERVICE}`,
            privilege:
              process.env.ORACLE_DB_ROLE === 'SYSDBA'
                ? oracledb.SYSDBA
                : undefined,
          });
          console.log('[Oracle] Test connection successful');
          await connection.close();
        } catch (err) {
          console.warn(
            '[Oracle] Test connection failed, but continuing:',
            (err as Error).message,
          );
        }
      }
    } catch (error) {
      console.error(
        '[Oracle] Failed to initialize Thick Mode:',
        (error as Error).message,
      );
      console.warn(
        '[Oracle] Falling back to Thin Mode. Some features may not work.',
      );
      console.warn(
        '[Oracle] Make sure Oracle Instant Client is installed at:',
        process.env.ORACLE_DB_INSTANT_CLIENT_DIR,
      );
    }
  } else {
    console.log('[Oracle] Thick Mode disabled, using Thin Mode');
  }
}

async function bootstrap() {
  try {
    console.log('[main.ts] Starting bootstrap...');

    // Initialize Oracle Thick Mode before anything else
    await initializeOracleThickMode();

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
      origin:
        process.env.CORS_ORIGIN ||
        (process.env.NODE_ENV === 'production'
          ? false
          : 'http://localhost:3000'),
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
      .setDescription(
        'Odoo → Oracle Fusion middleware - enterprise integration system',
      )
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('docs', app, document);
    console.log('[main.ts] Swagger configured');

    const port = process.env.PORT || 3001;
    console.log(`[main.ts] Starting server on port ${port}...`);
    await app.listen(port);
    console.log(`[main.ts] Server listening on port ${port}!`);
  } catch (error) {
    console.error('[main.ts] Bootstrap failed:', error);
    process.exit(1);
  }
}

void bootstrap();
