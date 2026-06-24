import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import {
  Logger as NestLogger,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import * as compression from 'compression';
import helmet from 'helmet';
import { json } from 'express';
import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';

// Ensure BigInt values (e.g. from Prisma BigInt fields) can be serialised to
// JSON without throwing "Do not know how to serialize a BigInt".  All BigInt
// account IDs used here fit within Number.MAX_SAFE_INTEGER so converting to
// number preserves precision.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(BigInt.prototype as any).toJSON = function () {
  return Number(this);
};

// Bootstrap-time logger (used before the Pino logger is attached to the app).
const bootstrapLogger = new NestLogger('Bootstrap');

// Initialize Oracle Thick Mode BEFORE creating the NestJS application
async function initializeOracleThickMode() {
  if (process.env.ORACLE_DB_THICK_MODE === 'true') {
    bootstrapLogger.log('Enabling Thick Mode…');

    try {
      // Dynamic import to avoid loading oracledb if not needed
      const oracledb = await import('oracledb');
      const instantClientDir = process.env.ORACLE_DB_INSTANT_CLIENT_DIR;

      if (instantClientDir) {
        oracledb.initOracleClient({ libDir: instantClientDir });
        bootstrapLogger.log(
          `Instant Client initialized from: ${instantClientDir}`,
        );
      } else {
        oracledb.initOracleClient();
        bootstrapLogger.log(
          'Instant Client initialized from system library path',
        );
      }

      bootstrapLogger.log(
        `Node-oracledb version: ${oracledb.versionString} — Thick Mode enabled`,
      );

      // Test connection (non-production only)
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
          bootstrapLogger.log('Oracle test connection successful');
          await connection.close();
        } catch (err) {
          bootstrapLogger.warn(
            `Oracle test connection failed, continuing: ${(err as Error).message}`,
          );
        }
      }
    } catch (error) {
      bootstrapLogger.error(
        `Failed to initialize Thick Mode: ${(error as Error).message}`,
      );
      bootstrapLogger.warn(
        `Falling back to Thin Mode. Ensure Oracle Instant Client is installed at: ${process.env.ORACLE_DB_INSTANT_CLIENT_DIR ?? '<not set>'}`,
      );
    }
  } else {
    bootstrapLogger.log('Oracle Thick Mode disabled — using Thin Mode');
  }
}

async function bootstrap() {
  try {
    bootstrapLogger.log('Starting bootstrap…');

    // Initialize Oracle Thick Mode before anything else
    await initializeOracleThickMode();

    const app = await NestFactory.create(AppModule, {
      bufferLogs: true,
      rawBody: true,
    });

    // Replace the buffered logger with Pino now that the app is created.
    app.useLogger(app.get(Logger));
    app.useGlobalFilters(new GlobalExceptionFilter());

    // Enable graceful shutdown so NestJS flushes connections on SIGTERM/SIGINT.
    // This is essential for zero-downtime rolling deployments in Kubernetes.
    app.enableShutdownHooks();

    // Limit request body size to 10 MB to protect against oversized payloads
    app.use(json({ limit: '10mb' }));

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

    app.use(compression());
    app.enableCors({
      origin:
        process.env.CORS_ORIGIN ||
        (process.env.NODE_ENV === 'production'
          ? false
          : 'http://localhost:3000'),
      credentials: true,
    });

    app.setGlobalPrefix(process.env.API_PREFIX || 'api/v1');
    app.enableVersioning({ type: VersioningType.URI });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );

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
    bootstrapLogger.log(`Server listening on port ${port}`);
  } catch (error) {
    bootstrapLogger.error(`Bootstrap failed: ${(error as Error).message}`);
    process.exit(1);
  }
}

void bootstrap();
