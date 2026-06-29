import { Injectable, Logger } from '@nestjs/common';
import { ErrorType } from '@prisma/client';

export interface ErrorCodeInfo {
  code: string;
  name: string;
  description: string;
  category: ErrorType;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  isRetryable: boolean;
  resolution: string[];
  preventionTips: string[];
  relatedDocs?: string;
  examplePayload?: any;
}

export interface ErrorAnalysis {
  errorInfo: ErrorCodeInfo;
  rootCause: string;
  immediateActions: string[];
  longTermFixes: string[];
  estimatedResolutionTime: string;
}

@Injectable()
export class ErrorResolutionService {
  private readonly logger = new Logger(ErrorResolutionService.name);

  // Comprehensive error code database
  private readonly errorCodeMap: Record<string, ErrorCodeInfo> = {
    // Oracle Connection Errors
    ORACLE_CONN_001: {
      code: 'ORACLE_CONN_001',
      name: 'Oracle Connection Timeout',
      description: 'Connection to Oracle server timed out',
      category: ErrorType.TIMEOUT,
      severity: 'HIGH',
      isRetryable: true,
      resolution: [
        'Check Oracle server status and availability',
        'Verify network connectivity to Oracle instance',
        'Check firewall rules allow traffic on Oracle ports',
        'Increase timeout setting in .env (ORACLE_TIMEOUT)',
        'Contact Oracle DBA if server is down',
      ],
      preventionTips: [
        'Set appropriate timeout values (>60 seconds)',
        'Monitor Oracle server health regularly',
        'Implement connection pooling',
        'Use circuit breaker pattern',
      ],
      relatedDocs: 'https://docs.oracle.com/en/cloud/connectivity',
    },

    ORACLE_CONN_002: {
      code: 'ORACLE_CONN_002',
      name: 'Oracle Authentication Failed',
      description:
        'Failed to authenticate with Oracle using provided credentials',
      category: ErrorType.AUTHENTICATION_ERROR,
      severity: 'CRITICAL',
      isRetryable: false,
      resolution: [
        'Verify ORACLE_USERNAME and ORACLE_PASSWORD in .env file',
        'Check if Oracle user account is active and not locked',
        'Verify user has required permissions for REST/SOAP APIs',
        'Check if password has expired',
        'Contact Oracle administrator to reset credentials',
      ],
      preventionTips: [
        'Use secure credential storage (AWS Secrets Manager, Azure Key Vault)',
        'Implement credential rotation policy',
        'Set up monitoring for authentication failures',
        'Use service accounts with appropriate permissions',
      ],
      relatedDocs: 'https://docs.oracle.com/en/cloud/authentication',
    },

    ORACLE_CONN_003: {
      code: 'ORACLE_CONN_003',
      name: 'Oracle Service Unavailable',
      description: 'Oracle REST/SOAP service returned 503 Service Unavailable',
      category: ErrorType.NETWORK_ERROR,
      severity: 'HIGH',
      isRetryable: true,
      resolution: [
        'Wait for Oracle service to recover (usually temporary)',
        'Check Oracle Cloud status page for outages',
        'Contact Oracle Support if issue persists >30 minutes',
        'Enable circuit breaker to prevent overwhelming Oracle',
      ],
      preventionTips: [
        'Implement exponential backoff retry logic',
        'Monitor Oracle service health proactively',
        'Set up alerts for service degradation',
      ],
    },

    // Data Validation Errors
    DATA_VAL_001: {
      code: 'DATA_VAL_001',
      name: 'Missing Required Field',
      description: 'Required field missing in payload sent to Oracle',
      category: ErrorType.VALIDATION_ERROR,
      severity: 'MEDIUM',
      isRetryable: false,
      resolution: [
        'Review payload structure and identify missing field',
        'Check source data (Odoo/IBQ) for completeness',
        'Update transformation logic to handle missing data',
        'Add default values for optional fields',
        'Contact data source admin to fix at origin',
      ],
      preventionTips: [
        'Implement pre-flight validation before sending to Oracle',
        'Add comprehensive data validation rules',
        'Set up data quality checks in source systems',
        'Use JSON schema validation',
      ],
      examplePayload: {
        error: 'Missing required field: billToCustomerNumber',
        receivedPayload: {
          transactionNumber: 'INV-12345',
          // billToCustomerNumber missing
        },
      },
    },

    DATA_VAL_002: {
      code: 'DATA_VAL_002',
      name: 'Invalid Date Format',
      description:
        'Date field does not match Oracle expected format (YYYY-MM-DD)',
      category: ErrorType.VALIDATION_ERROR,
      severity: 'MEDIUM',
      isRetryable: false,
      resolution: [
        'Convert all dates to UTC before sending to Oracle',
        'Use ISO 8601 format (YYYY-MM-DDTHH:mm:ss.sssZ)',
        'Check timezone conversion logic',
        'Verify date parsing in transformation service',
        'Review Odoo/IBQ date format and add conversion',
      ],
      preventionTips: [
        'Always store dates in UTC in database',
        'Use moment.js or date-fns for consistent date handling',
        'Validate date format before sending to Oracle',
        'Document expected date format in all APIs',
      ],
      examplePayload: {
        invalid: '01/15/2024',
        valid: '2024-01-15T00:00:00.000Z',
      },
    },

    DATA_VAL_003: {
      code: 'DATA_VAL_003',
      name: 'Invalid Currency Precision',
      description: 'Currency amount has incorrect decimal precision',
      category: ErrorType.VALIDATION_ERROR,
      severity: 'MEDIUM',
      isRetryable: false,
      resolution: [
        'Round currency amounts to 2 decimal places',
        'Check source data for precision issues',
        'Update transformation logic to handle precision',
        'Verify currency code matches Oracle expectations',
      ],
      preventionTips: [
        'Use Decimal type for all currency fields',
        'Always round to 2 decimal places for AED, USD, etc.',
        'Validate currency precision in pre-flight checks',
      ],
      examplePayload: {
        invalid: { amount: 123.456, currency: 'AED' },
        valid: { amount: 123.46, currency: 'AED' },
      },
    },

    DATA_VAL_004: {
      code: 'DATA_VAL_004',
      name: 'NULL vs Empty String',
      description:
        'Oracle expects empty string but received NULL (or vice versa)',
      category: ErrorType.VALIDATION_ERROR,
      severity: 'LOW',
      isRetryable: false,
      resolution: [
        'Review Oracle field requirements (NULL vs empty string)',
        'Update transformation to convert NULL to empty string',
        'Or convert empty string to NULL based on Oracle schema',
        'Check XML/JSON schema documentation',
      ],
      preventionTips: [
        'Document NULL handling for each Oracle field',
        'Implement consistent NULL handling strategy',
        'Test with both NULL and empty string values',
      ],
    },

    // Mapping Errors
    MAPPING_001: {
      code: 'MAPPING_001',
      name: 'Payment Method Not Mapped',
      description:
        'Payment method from source system not found in mapping table',
      category: ErrorType.PAYMENT_METHOD_ERROR,
      severity: 'MEDIUM',
      isRetryable: false,
      resolution: [
        'Go to Admin > Payment Method Mapping',
        'Add mapping for the missing payment method',
        'Contact Oracle admin for Oracle Receipt Method ID',
        'Retry order after mapping is added',
      ],
      preventionTips: [
        'Set up all payment methods during initial configuration',
        'Enable auto-create missing payment methods if appropriate',
        'Monitor alerts for unmapped payment methods',
        'Review payment methods quarterly',
      ],
      relatedDocs: '/admin/payment-mapping',
    },

    MAPPING_002: {
      code: 'MAPPING_002',
      name: 'Store Configuration Not Found',
      description:
        'Store/branch configuration missing in StoreConfiguration table',
      category: ErrorType.CONFIGURATION_ERROR,
      severity: 'HIGH',
      isRetryable: false,
      resolution: [
        'Go to Admin > Store Configuration',
        'Add configuration for the missing branch code',
        'Fill in all required Oracle mapping fields',
        'Validate configuration before saving',
        'Retry order after configuration is added',
      ],
      preventionTips: [
        'Configure all branches during initial setup',
        'Run validation checks on store configurations',
        'Set up alerts for missing configurations',
      ],
      relatedDocs: '/admin/stores',
    },

    // Inventory Errors
    INVENTORY_001: {
      code: 'INVENTORY_001',
      name: 'Negative Inventory Detected',
      description: 'Order would result in negative inventory in Oracle',
      category: ErrorType.INVENTORY_ERROR,
      severity: 'MEDIUM',
      isRetryable: true,
      resolution: [
        'Check Oracle inventory levels for the affected items',
        'Perform inventory adjustment in Oracle if needed',
        'Contact inventory manager to reconcile stock',
        'Use "Retry Negative Inventory Orders" after correction',
        'Enable allowNegativeInventory in store config if appropriate',
      ],
      preventionTips: [
        'Implement real-time inventory sync',
        'Set up low stock alerts',
        'Perform regular inventory audits',
        'Configure inventory thresholds',
      ],
    },

    // Rate Limiting
    RATE_LIMIT_001: {
      code: 'RATE_LIMIT_001',
      name: 'Oracle Rate Limit Exceeded',
      description: 'Too many requests to Oracle API in short time period',
      category: ErrorType.RATE_LIMIT_ERROR,
      severity: 'MEDIUM',
      isRetryable: true,
      resolution: [
        'System will automatically retry with backoff',
        'Reduce batch size if processing large volumes',
        'Contact Oracle to increase rate limits',
        'Implement request throttling',
      ],
      preventionTips: [
        'Implement rate limiting in application',
        'Use bulk APIs where available',
        'Distribute load across time windows',
        'Monitor API usage metrics',
      ],
    },

    // Duplicate Errors
    DUPLICATE_001: {
      code: 'DUPLICATE_001',
      name: 'Duplicate Transaction',
      description: 'Transaction already exists in Oracle with same ID',
      category: ErrorType.DUPLICATE_ERROR,
      severity: 'LOW',
      isRetryable: false,
      resolution: [
        'This is expected behavior - transaction already synced',
        'Mark order as SYNCED in database',
        'No action required',
      ],
      preventionTips: [
        'Implement idempotency checks before sending',
        'Use AuditLog table to track processed transactions',
        'Add unique constraints in database',
      ],
    },

    // Network Errors
    NETWORK_001: {
      code: 'NETWORK_001',
      name: 'Network Connection Lost',
      description: 'Network connection interrupted during Oracle API call',
      category: ErrorType.NETWORK_ERROR,
      severity: 'MEDIUM',
      isRetryable: true,
      resolution: [
        'System will automatically retry',
        'Check network connectivity',
        'Verify VPN connection if required',
        'Contact network admin if issue persists',
      ],
      preventionTips: [
        'Use stable network connection',
        'Implement connection pooling',
        'Set appropriate timeout values',
        'Monitor network health',
      ],
    },

    // Unknown Errors
    UNKNOWN_001: {
      code: 'UNKNOWN_001',
      name: 'Unclassified Error',
      description: 'An unexpected error occurred',
      category: ErrorType.UNKNOWN_ERROR,
      severity: 'HIGH',
      isRetryable: true,
      resolution: [
        'Review error logs for full stack trace',
        'Check Oracle error message in response',
        'Contact support with error details',
        'Provide: order ID, timestamp, full error message',
      ],
      preventionTips: [
        'Enable comprehensive logging',
        'Implement proper error handling in all code paths',
        'Monitor for unknown errors and classify them',
      ],
    },
  };

  /**
   * Get error information by code
   */
  getErrorInfo(errorCode: string): ErrorCodeInfo | null {
    return this.errorCodeMap[errorCode] || null;
  }

  /**
   * Analyze error and provide resolution guidance
   */
  analyzeError(
    errorType: ErrorType,
    errorMessage: string,
    errorCode?: string,
  ): ErrorAnalysis {
    // Try to find specific error code first
    let errorInfo: ErrorCodeInfo | null = null;

    if (errorCode && this.errorCodeMap[errorCode]) {
      errorInfo = this.errorCodeMap[errorCode];
    } else {
      // Try to infer error code from message and type
      errorCode = this.inferErrorCode(errorType, errorMessage);
      errorInfo =
        this.errorCodeMap[errorCode] || this.getDefaultErrorInfo(errorType);
    }

    // Analyze root cause
    const rootCause = this.determineRootCause(errorType, errorMessage);

    // Generate immediate actions
    const immediateActions = this.generateImmediateActions(
      errorInfo,
      errorMessage,
    );

    // Generate long-term fixes
    const longTermFixes = this.generateLongTermFixes(errorInfo);

    // Estimate resolution time
    const estimatedResolutionTime = this.estimateResolutionTime(
      errorInfo.severity,
    );

    return {
      errorInfo,
      rootCause,
      immediateActions,
      longTermFixes,
      estimatedResolutionTime,
    };
  }

  /**
   * Infer error code from error type and message
   */
  private inferErrorCode(errorType: ErrorType, errorMessage: string): string {
    const lowerMessage = errorMessage.toLowerCase();

    // Connection/timeout errors
    if (
      lowerMessage.includes('timeout') ||
      lowerMessage.includes('timed out')
    ) {
      return 'ORACLE_CONN_001';
    }
    if (
      lowerMessage.includes('authentication') ||
      lowerMessage.includes('401') ||
      lowerMessage.includes('unauthorized')
    ) {
      return 'ORACLE_CONN_002';
    }
    if (
      lowerMessage.includes('503') ||
      lowerMessage.includes('service unavailable')
    ) {
      return 'ORACLE_CONN_003';
    }

    // Validation errors
    if (
      lowerMessage.includes('required field') ||
      lowerMessage.includes('missing')
    ) {
      return 'DATA_VAL_001';
    }
    if (
      lowerMessage.includes('date') &&
      (lowerMessage.includes('format') || lowerMessage.includes('invalid'))
    ) {
      return 'DATA_VAL_002';
    }
    if (
      lowerMessage.includes('currency') ||
      lowerMessage.includes('precision') ||
      lowerMessage.includes('decimal')
    ) {
      return 'DATA_VAL_003';
    }

    // Mapping errors
    if (
      lowerMessage.includes('payment method') &&
      lowerMessage.includes('not found')
    ) {
      return 'MAPPING_001';
    }
    if (lowerMessage.includes('store') || lowerMessage.includes('branch')) {
      return 'MAPPING_002';
    }

    // Inventory errors
    if (
      lowerMessage.includes('negative inventory') ||
      lowerMessage.includes('insufficient stock')
    ) {
      return 'INVENTORY_001';
    }

    // Rate limiting
    if (
      lowerMessage.includes('rate limit') ||
      lowerMessage.includes('429') ||
      lowerMessage.includes('too many requests')
    ) {
      return 'RATE_LIMIT_001';
    }

    // Duplicates
    if (
      lowerMessage.includes('duplicate') ||
      lowerMessage.includes('already exists')
    ) {
      return 'DUPLICATE_001';
    }

    // Network
    if (errorType === ErrorType.NETWORK_ERROR) {
      return 'NETWORK_001';
    }

    // Default unknown
    return 'UNKNOWN_001';
  }

  /**
   * Get default error info for error type
   */
  private getDefaultErrorInfo(errorType: ErrorType): ErrorCodeInfo {
    return {
      code: 'UNKNOWN_001',
      name: 'Unclassified Error',
      description: `Error of type: ${errorType}`,
      category: errorType,
      severity: 'HIGH',
      isRetryable: this.isRetryable(errorType),
      resolution: [
        'Review detailed error logs',
        'Check Oracle documentation',
        'Contact support if issue persists',
      ],
      preventionTips: [
        'Enable comprehensive logging',
        'Implement proper error handling',
      ],
    };
  }

  /**
   * Determine if error type is retryable
   */
  private isRetryable(errorType: ErrorType): boolean {
    const retryableTypes: ErrorType[] = [
      ErrorType.NETWORK_ERROR,
      ErrorType.TIMEOUT,
      ErrorType.RATE_LIMIT_ERROR,
      ErrorType.UNKNOWN_ERROR,
    ];
    return retryableTypes.includes(errorType);
  }

  /**
   * Determine root cause from error details
   */
  private determineRootCause(
    errorType: ErrorType,
    errorMessage: string,
  ): string {
    const lowerMessage = errorMessage.toLowerCase();

    if (errorType === ErrorType.AUTHENTICATION_ERROR) {
      return 'Invalid or expired Oracle credentials';
    }
    if (errorType === ErrorType.TIMEOUT && lowerMessage.includes('connect')) {
      return 'Oracle server unreachable - possible network or firewall issue';
    }
    if (
      errorType === ErrorType.VALIDATION_ERROR &&
      lowerMessage.includes('required')
    ) {
      return 'Missing required data in source system or transformation logic';
    }
    if (errorType === ErrorType.CONFIGURATION_ERROR) {
      return 'Incomplete or invalid configuration in admin settings';
    }
    if (errorType === ErrorType.PAYMENT_METHOD_ERROR) {
      return 'Payment method mapping not configured in system';
    }
    if (errorType === ErrorType.INVENTORY_ERROR) {
      return 'Inventory mismatch between source system and Oracle';
    }

    return 'Unable to determine specific root cause - review error logs for details';
  }

  /**
   * Generate immediate action items
   */
  private generateImmediateActions(
    errorInfo: ErrorCodeInfo,
    errorMessage: string,
  ): string[] {
    const actions: string[] = [...errorInfo.resolution];

    // Add context-specific actions
    if (errorMessage.includes('network')) {
      actions.push('Check VPN connection if working remotely');
      actions.push('Ping Oracle server to verify connectivity');
    }

    if (
      errorMessage.includes('permission') ||
      errorMessage.includes('forbidden')
    ) {
      actions.push('Verify user account has required Oracle roles');
      actions.push('Check Oracle security policies');
    }

    return actions;
  }

  /**
   * Generate long-term fix recommendations
   */
  private generateLongTermFixes(errorInfo: ErrorCodeInfo): string[] {
    return errorInfo.preventionTips;
  }

  /**
   * Estimate resolution time based on severity
   */
  private estimateResolutionTime(severity: ErrorCodeInfo['severity']): string {
    switch (severity) {
      case 'LOW':
        return '< 30 minutes - Can be resolved by operations team';
      case 'MEDIUM':
        return '1-4 hours - May require configuration changes or data fixes';
      case 'HIGH':
        return '4-24 hours - Requires admin intervention or Oracle support';
      case 'CRITICAL':
        return '< 1 hour - Immediate attention required, escalate to senior team';
      default:
        return 'Unknown - Contact support';
    }
  }

  /**
   * Get all error codes for documentation
   */
  getAllErrorCodes(): ErrorCodeInfo[] {
    return Object.values(this.errorCodeMap);
  }

  /**
   * Get error codes by category
   */
  getErrorCodesByCategory(category: ErrorType): ErrorCodeInfo[] {
    return Object.values(this.errorCodeMap).filter(
      (info) => info.category === category,
    );
  }

  /**
   * Search error codes
   */
  searchErrorCodes(query: string): ErrorCodeInfo[] {
    const lowerQuery = query.toLowerCase();
    return Object.values(this.errorCodeMap).filter(
      (info) =>
        info.name.toLowerCase().includes(lowerQuery) ||
        info.description.toLowerCase().includes(lowerQuery) ||
        info.code.toLowerCase().includes(lowerQuery),
    );
  }
}
