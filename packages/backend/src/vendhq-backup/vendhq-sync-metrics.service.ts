import { Injectable, Logger } from '@nestjs/common';
import { Histogram, Counter, Gauge, Registry } from 'prom-client';

/**
 * VendHQ Sync Metrics Service
 * 
 * Provides custom Prometheus metrics for VendHQ → Oracle sync operations:
 * - Sync duration histograms per region
 * - Success/failure counters
 * - SOAP call latency tracking
 * - Transformation performance metrics
 * - Error rate monitoring
 */
@Injectable()
export class VendHqSyncMetricsService {
  private readonly logger = new Logger(VendHqSyncMetricsService.name);

  // Sync duration histogram
  private readonly syncDurationHistogram: Histogram;

  // SOAP call duration histogram
  private readonly soapCallDurationHistogram: Histogram;

  // Transformation duration histogram
  private readonly transformationDurationHistogram: Histogram;

  // Success counter
  private readonly syncSuccessCounter: Counter;

  // Failure counter
  private readonly syncFailureCounter: Counter;

  // Sync batch size gauge
  private readonly syncBatchSizeGauge: Gauge;

  // Currently syncing sales gauge
  private readonly currentlySyncingGauge: Gauge;

  // SOAP call error counter
  private readonly soapCallErrorCounter: Counter;

  // Transformation error counter
  private readonly transformationErrorCounter: Counter;

  constructor(private readonly registry: Registry) {
    // Sync duration: Total time to sync one sale
    this.syncDurationHistogram = new Histogram({
      name: 'vendhq_sync_duration_seconds',
      help: 'Duration of VendHQ sale sync in seconds',
      labelNames: ['region', 'status'],
      buckets: [0.5, 1, 2, 5, 10, 15, 30, 60, 120],
      registers: [this.registry],
    });

    // SOAP call duration: Time for Oracle SOAP API calls
    this.soapCallDurationHistogram = new Histogram({
      name: 'vendhq_sync_soap_call_duration_seconds',
      help: 'Duration of Oracle SOAP API calls in seconds',
      labelNames: ['region', 'operation', 'status'],
      buckets: [0.1, 0.5, 1, 2, 5, 10, 15, 30],
      registers: [this.registry],
    });

    // Transformation duration: Time to transform VendHQ → Oracle format
    this.transformationDurationHistogram = new Histogram({
      name: 'vendhq_sync_transformation_duration_seconds',
      help: 'Duration of VendHQ to Oracle transformation in seconds',
      labelNames: ['region'],
      buckets: [0.01, 0.05, 0.1, 0.5, 1, 2],
      registers: [this.registry],
    });

    // Success counter
    this.syncSuccessCounter = new Counter({
      name: 'vendhq_sync_success_total',
      help: 'Total number of successful VendHQ sales synced',
      labelNames: ['region'],
      registers: [this.registry],
    });

    // Failure counter
    this.syncFailureCounter = new Counter({
      name: 'vendhq_sync_failure_total',
      help: 'Total number of failed VendHQ sales syncs',
      labelNames: ['region', 'error_type'],
      registers: [this.registry],
    });

    // Batch size gauge
    this.syncBatchSizeGauge = new Gauge({
      name: 'vendhq_sync_batch_size',
      help: 'Number of sales in current sync batch',
      labelNames: ['region'],
      registers: [this.registry],
    });

    // Currently syncing gauge
    this.currentlySyncingGauge = new Gauge({
      name: 'vendhq_sync_currently_syncing',
      help: 'Number of sales currently being synced',
      labelNames: ['region'],
      registers: [this.registry],
    });

    // SOAP call error counter
    this.soapCallErrorCounter = new Counter({
      name: 'vendhq_sync_soap_error_total',
      help: 'Total number of Oracle SOAP API errors',
      labelNames: ['region', 'operation', 'error_code'],
      registers: [this.registry],
    });

    // Transformation error counter
    this.transformationErrorCounter = new Counter({
      name: 'vendhq_sync_transformation_error_total',
      help: 'Total number of transformation errors',
      labelNames: ['region', 'error_type'],
      registers: [this.registry],
    });
  }

  /**
   * Record sync duration for a single sale
   */
  recordSyncDuration(region: string, duration: number, status: 'success' | 'failure'): void {
    this.syncDurationHistogram.observe({ region, status }, duration);
    this.logger.debug(`Sync duration for ${region}: ${duration}s (${status})`);
  }

  /**
   * Record SOAP call duration
   */
  recordSoapCallDuration(
    region: string,
    operation: string,
    duration: number,
    status: 'success' | 'failure',
  ): void {
    this.soapCallDurationHistogram.observe({ region, operation, status }, duration);
    this.logger.debug(`SOAP call ${operation} for ${region}: ${duration}s (${status})`);
  }

  /**
   * Record transformation duration
   */
  recordTransformationDuration(region: string, duration: number): void {
    this.transformationDurationHistogram.observe({ region }, duration);
    this.logger.debug(`Transformation for ${region}: ${duration}s`);
  }

  /**
   * Increment success counter
   */
  incrementSuccessCounter(region: string): void {
    this.syncSuccessCounter.inc({ region });
  }

  /**
   * Increment failure counter
   */
  incrementFailureCounter(region: string, errorType: string): void {
    this.syncFailureCounter.inc({ region, error_type: errorType });
  }

  /**
   * Set batch size gauge
   */
  setBatchSize(region: string, size: number): void {
    this.syncBatchSizeGauge.set({ region }, size);
  }

  /**
   * Increment currently syncing gauge
   */
  incrementCurrentlySyncing(region: string): void {
    this.currentlySyncingGauge.inc({ region });
  }

  /**
   * Decrement currently syncing gauge
   */
  decrementCurrentlySyncing(region: string): void {
    this.currentlySyncingGauge.dec({ region });
  }

  /**
   * Record SOAP call error
   */
  recordSoapCallError(region: string, operation: string, errorCode: string): void {
    this.soapCallErrorCounter.inc({ region, operation, error_code: errorCode });
    this.logger.warn(`SOAP error for ${region} ${operation}: ${errorCode}`);
  }

  /**
   * Record transformation error
   */
  recordTransformationError(region: string, errorType: string): void {
    this.transformationErrorCounter.inc({ region, error_type: errorType });
    this.logger.warn(`Transformation error for ${region}: ${errorType}`);
  }

  /**
   * Helper: Start timing an operation
   * Returns an end function to record the duration
   */
  startTimer(): () => number {
    const startTime = Date.now();
    return (): number => {
      const duration = (Date.now() - startTime) / 1000; // Convert to seconds
      return duration;
    };
  }

  /**
   * Helper: Classify error type for metrics
   */
  classifyErrorType(error: Error): string {
    const message = error.message.toLowerCase();

    if (message.includes('timeout')) {
      return 'timeout';
    }
    if (message.includes('connection')) {
      return 'connection';
    }
    if (message.includes('invalid') || message.includes('validation')) {
      return 'validation';
    }
    if (message.includes('not found')) {
      return 'not_found';
    }
    if (message.includes('unauthorized') || message.includes('authentication')) {
      return 'authentication';
    }
    if (message.includes('rate limit')) {
      return 'rate_limit';
    }
    if (message.includes('oracle soap')) {
      return 'oracle_soap';
    }
    if (message.includes('database')) {
      return 'database';
    }
    if (message.includes('transformation')) {
      return 'transformation';
    }

    return 'unknown';
  }

  /**
   * Helper: Extract error code from SOAP error
   */
  extractSoapErrorCode(error: Error): string {
    const message = error.message;

    // Extract HTTP status codes
    const httpMatch = message.match(/status code (\d+)/i);
    if (httpMatch) {
      return httpMatch[1];
    }

    // Extract Oracle error codes
    const oracleMatch = message.match(/ORA-(\d+)/i);
    if (oracleMatch) {
      return `ORA-${oracleMatch[1]}`;
    }

    // Check for specific error types
    if (message.includes('Status E')) {
      return 'STATUS_E';
    }
    if (message.includes('timeout')) {
      return 'TIMEOUT';
    }
    if (message.includes('connection')) {
      return 'CONNECTION_ERROR';
    }

    return 'UNKNOWN';
  }
}
