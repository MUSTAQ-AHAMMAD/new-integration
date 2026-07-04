import { Injectable, Logger } from '@nestjs/common';
import Decimal from 'decimal.js';

export interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
  fixedFields?: Record<string, any>;
}

export interface OracleInvoicePayload {
  billToCustomerNumber?: string;
  transactionNumber?: string;
  transactionDate?: string;
  currencyCode?: string;
  amount?: number;
  businessUnit?: string;
  transactionSource?: string;
  transactionType?: string;
  lines?: Array<{
    lineNumber: number;
    itemNumber?: string;
    description?: string;
    quantity: number;
    unitSellingPrice: number;
    [key: string]: any;
  }>;
  [key: string]: any;
}

export interface OracleReceiptPayload {
  receiptMethodId?: number;
  receiptNumber?: string;
  currencyCode?: string;
  receiptAmount?: number;
  saleDate?: string;
  remittanceBankAccountId?: number;
  [key: string]: any;
}

@Injectable()
export class PreFlightValidationService {
  private readonly logger = new Logger(PreFlightValidationService.name);

  // Required fields for each Oracle operation type
  private readonly requiredFields = {
    invoice: [
      'billToCustomerNumber',
      'transactionNumber',
      'transactionDate',
      'currencyCode',
      'businessUnit',
      'transactionSource',
      'transactionType',
    ],
    receipt: [
      'receiptMethodId',
      'receiptNumber',
      'currencyCode',
      'receiptAmount',
      'saleDate',
    ],
    creditMemo: ['creditMemoNumber', 'transactionDate', 'amount', 'reason'],
    journal: [
      'batchName',
      'ledgerId',
      'accountingDate',
      'userSourceName',
      'userCategoryName',
    ],
  };

  // Supported currency codes with decimal precision
  private readonly currencyConfig = {
    AED: { decimals: 2, symbol: 'د.إ' },
    USD: { decimals: 2, symbol: '$' },
    EUR: { decimals: 2, symbol: '€' },
    GBP: { decimals: 2, symbol: '£' },
    SAR: { decimals: 2, symbol: '﷼' },
    KWD: { decimals: 3, symbol: 'د.ك' }, // Kuwait Dinar uses 3 decimals
    OMR: { decimals: 3, symbol: 'ر.ع.' }, // Omani Rial uses 3 decimals
    BHD: { decimals: 3, symbol: '.د.ب' }, // Bahraini Dinar uses 3 decimals
  };

  /**
   * Validate invoice payload before sending to Oracle
   */
  validateInvoice(payload: OracleInvoicePayload): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    const fixedFields: Record<string, any> = {};

    this.logger.debug(
      `Validating invoice payload: ${payload.transactionNumber}`,
    );

    // 1. Check required fields
    for (const field of this.requiredFields.invoice) {
      if (!payload[field]) {
        errors.push(`Missing required field: ${field}`);
      }
    }

    // 2. Validate transaction number format
    if (payload.transactionNumber) {
      if (payload.transactionNumber.length > 50) {
        errors.push(
          'Transaction number exceeds maximum length (50 characters)',
        );
      }
      if (!/^[A-Z0-9\-_]+$/i.test(payload.transactionNumber)) {
        warnings.push(
          'Transaction number contains special characters - may cause issues in Oracle',
        );
      }
    }

    // 3. Validate date format (must be UTC ISO 8601)
    if (payload.transactionDate) {
      const dateResult = this.validateDate(payload.transactionDate);
      if (!dateResult.isValid) {
        errors.push(`Invalid transaction date: ${dateResult.error}`);
      } else if (dateResult.fixed) {
        fixedFields.transactionDate = dateResult.fixed;
        warnings.push(
          `Transaction date auto-converted to UTC: ${dateResult.fixed}`,
        );
      }
    }

    // 4. Validate currency code and precision
    if (payload.currencyCode) {
      const currencyResult = this.validateCurrency(
        payload.currencyCode,
        payload.amount,
      );
      if (!currencyResult.isValid) {
        errors.push(currencyResult.error!);
      } else if (currencyResult.fixed !== undefined) {
        fixedFields.amount = currencyResult.fixed;
        warnings.push(
          `Amount precision adjusted for ${payload.currencyCode}: ${currencyResult.fixed}`,
        );
      }
    }

    // 5. Validate amount (must be positive for invoices)
    if (payload.amount !== undefined) {
      if (payload.amount < 0) {
        errors.push(
          'Invoice amount cannot be negative (use credit memo for refunds)',
        );
      }
      if (payload.amount === 0) {
        warnings.push('Invoice amount is zero - verify this is intentional');
      }
      if (payload.amount > 999999999.99) {
        errors.push('Invoice amount exceeds maximum value (999,999,999.99)');
      }
    }

    // 6. Validate business unit
    if (payload.businessUnit) {
      if (payload.businessUnit.length > 30) {
        errors.push(
          'Business unit name exceeds maximum length (30 characters)',
        );
      }
    }

    // 7. Validate invoice lines
    if (payload.lines && payload.lines.length > 0) {
      const lineResult = this.validateInvoiceLines(
        payload.lines,
        payload.currencyCode!,
      );
      errors.push(...lineResult.errors);
      warnings.push(...lineResult.warnings);
      if (Object.keys(lineResult.fixedFields || {}).length > 0) {
        fixedFields.lines = lineResult.fixedFields;
      }
    } else {
      errors.push('Invoice must have at least one line item');
    }

    // 8. Validate NULL vs empty string for optional fields
    const nullCheckResult = this.validateNullHandling(payload);
    if (Object.keys(nullCheckResult).length > 0) {
      Object.assign(fixedFields, nullCheckResult);
      warnings.push('Some fields auto-converted from NULL to empty string');
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
      fixedFields:
        Object.keys(fixedFields).length > 0 ? fixedFields : undefined,
    };
  }

  /**
   * Validate receipt payload before sending to Oracle
   */
  validateReceipt(payload: OracleReceiptPayload): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    const fixedFields: Record<string, any> = {};

    this.logger.debug(`Validating receipt payload: ${payload.receiptNumber}`);

    // 1. Check required fields
    for (const field of this.requiredFields.receipt) {
      if (!payload[field]) {
        errors.push(`Missing required field: ${field}`);
      }
    }

    // 2. Validate receipt number
    if (payload.receiptNumber) {
      if (payload.receiptNumber.length > 50) {
        errors.push('Receipt number exceeds maximum length (50 characters)');
      }
    }

    // 3. Validate date
    if (payload.saleDate) {
      const dateResult = this.validateDate(payload.saleDate);
      if (!dateResult.isValid) {
        errors.push(`Invalid sale date: ${dateResult.error}`);
      } else if (dateResult.fixed) {
        fixedFields.saleDate = dateResult.fixed;
        warnings.push(`Sale date auto-converted to UTC: ${dateResult.fixed}`);
      }
    }

    // 4. Validate currency and amount
    if (payload.currencyCode && payload.receiptAmount !== undefined) {
      const currencyResult = this.validateCurrency(
        payload.currencyCode,
        payload.receiptAmount,
      );
      if (!currencyResult.isValid) {
        errors.push(currencyResult.error!);
      } else if (currencyResult.fixed !== undefined) {
        fixedFields.receiptAmount = currencyResult.fixed;
        warnings.push(
          `Receipt amount precision adjusted: ${currencyResult.fixed}`,
        );
      }
    }

    // 5. Validate receipt amount (must be positive)
    if (payload.receiptAmount !== undefined) {
      if (payload.receiptAmount <= 0) {
        errors.push('Receipt amount must be greater than zero');
      }
      if (payload.receiptAmount > 999999999.99) {
        errors.push('Receipt amount exceeds maximum value');
      }
    }

    // 6. Validate receipt method ID (must be positive integer)
    if (payload.receiptMethodId !== undefined) {
      if (
        !Number.isInteger(payload.receiptMethodId) ||
        payload.receiptMethodId <= 0
      ) {
        errors.push('Receipt method ID must be a positive integer');
      }
    }

    // 7. Validate bank account ID if provided
    if (payload.remittanceBankAccountId !== undefined) {
      if (
        !Number.isInteger(payload.remittanceBankAccountId) ||
        payload.remittanceBankAccountId <= 0
      ) {
        errors.push('Bank account ID must be a positive integer');
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
      fixedFields:
        Object.keys(fixedFields).length > 0 ? fixedFields : undefined,
    };
  }

  /**
   * Validate date format and convert to UTC if needed
   */
  private validateDate(dateValue: string): {
    isValid: boolean;
    error?: string;
    fixed?: string;
  } {
    try {
      // Try to parse the date
      const date = new Date(dateValue);

      // Check if date is valid
      if (isNaN(date.getTime())) {
        return {
          isValid: false,
          error: 'Invalid date format - unable to parse',
        };
      }

      // Check if date is in reasonable range (not too far in past or future)
      const now = new Date();
      const tenYearsAgo = new Date(now.getFullYear() - 10, 0, 1);
      const fiveYearsAhead = new Date(now.getFullYear() + 5, 11, 31);

      if (date < tenYearsAgo) {
        return {
          isValid: false,
          error: 'Date is more than 10 years in the past',
        };
      }

      if (date > fiveYearsAhead) {
        return {
          isValid: false,
          error: 'Date is more than 5 years in the future',
        };
      }

      // Convert to ISO 8601 UTC format
      const utcDate = date.toISOString();

      // Check if input was already in correct format
      if (dateValue === utcDate) {
        return { isValid: true };
      }

      // Return fixed version
      return {
        isValid: true,
        fixed: utcDate,
      };
    } catch (err) {
      return {
        isValid: false,
        error: (err as Error).message,
      };
    }
  }

  /**
   * Validate currency code and amount precision
   */
  private validateCurrency(
    currencyCode: string,
    amount: number | undefined,
  ): {
    isValid: boolean;
    error?: string;
    fixed?: number;
  } {
    // Check if currency is supported
    if (
      !this.currencyConfig[currencyCode as keyof typeof this.currencyConfig]
    ) {
      return {
        isValid: false,
        error: `Unsupported currency code: ${currencyCode}`,
      };
    }

    if (amount === undefined) {
      return { isValid: true };
    }

    // Get currency configuration
    const config =
      this.currencyConfig[currencyCode as keyof typeof this.currencyConfig];

    // Check decimal precision
    const decimal = new Decimal(amount);
    const decimalPlaces = decimal.decimalPlaces();

    if (decimalPlaces > config.decimals) {
      // Fix by rounding to correct precision
      const fixed = decimal
        .toDecimalPlaces(config.decimals, Decimal.ROUND_HALF_UP)
        .toNumber();
      return {
        isValid: true,
        fixed,
      };
    }

    return { isValid: true };
  }

  /**
   * Validate invoice lines
   */
  private validateInvoiceLines(
    lines: any[],
    currencyCode: string,
  ): {
    errors: string[];
    warnings: string[];
    fixedFields?: Record<string, any>;
  } {
    const errors: string[] = [];
    const warnings: string[] = [];
    const fixedFields: Record<string, any> = {};

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const linePrefix = `Line ${i + 1}`;

      // Check required line fields
      if (!line.lineNumber) {
        errors.push(`${linePrefix}: Missing line number`);
      }
      if (!line.quantity) {
        errors.push(`${linePrefix}: Missing quantity`);
      } else if (line.quantity <= 0) {
        errors.push(`${linePrefix}: Quantity must be greater than zero`);
      }
      if (line.unitSellingPrice === undefined) {
        errors.push(`${linePrefix}: Missing unit selling price`);
      } else if (line.unitSellingPrice < 0) {
        errors.push(`${linePrefix}: Unit price cannot be negative`);
      }

      // Validate currency precision for line amount
      if (line.unitSellingPrice !== undefined) {
        const currencyResult = this.validateCurrency(
          currencyCode,
          line.unitSellingPrice,
        );
        if (!currencyResult.isValid) {
          errors.push(`${linePrefix}: ${currencyResult.error}`);
        } else if (currencyResult.fixed !== undefined) {
          if (!fixedFields[i]) fixedFields[i] = {};
          fixedFields[i].unitSellingPrice = currencyResult.fixed;
          warnings.push(
            `${linePrefix}: Price precision adjusted to ${currencyResult.fixed}`,
          );
        }
      }

      // Validate item number if provided
      if (line.itemNumber) {
        if (line.itemNumber.length > 40) {
          errors.push(
            `${linePrefix}: Item number exceeds maximum length (40 characters)`,
          );
        }
      }

      // Validate description
      if (line.description && line.description.length > 240) {
        warnings.push(
          `${linePrefix}: Description exceeds recommended length (240 characters) - may be truncated`,
        );
      }
    }

    return { errors, warnings, fixedFields };
  }

  /**
   * Validate and fix NULL vs empty string handling
   */
  private validateNullHandling(payload: any): Record<string, any> {
    const fixed: Record<string, any> = {};

    // Fields that Oracle expects as empty string instead of NULL
    const emptyStringFields = [
      'customerEmail',
      'customerPhone',
      'description',
      'notes',
      'reference',
    ];

    for (const field of emptyStringFields) {
      if (payload[field] === null || payload[field] === undefined) {
        fixed[field] = '';
      }
    }

    // Fields that Oracle expects as NULL instead of empty string
    const nullFields = ['taxClassificationCode', 'paymentTermsName'];

    for (const field of nullFields) {
      if (payload[field] === '') {
        fixed[field] = null;
      }
    }

    return fixed;
  }

  /**
   * Validate complete order payload with all components
   */
  validateCompleteOrder(order: {
    invoice: OracleInvoicePayload;
    receipt?: OracleReceiptPayload;
    applyReceipt?: any;
  }): ValidationResult {
    const allErrors: string[] = [];
    const allWarnings: string[] = [];
    const allFixedFields: Record<string, any> = {};

    // Validate invoice
    const invoiceResult = this.validateInvoice(order.invoice);
    allErrors.push(...invoiceResult.errors.map((e) => `Invoice: ${e}`));
    allWarnings.push(...invoiceResult.warnings.map((w) => `Invoice: ${w}`));
    if (invoiceResult.fixedFields) {
      allFixedFields.invoice = invoiceResult.fixedFields;
    }

    // Validate receipt if provided
    if (order.receipt) {
      const receiptResult = this.validateReceipt(order.receipt);
      allErrors.push(...receiptResult.errors.map((e) => `Receipt: ${e}`));
      allWarnings.push(...receiptResult.warnings.map((w) => `Receipt: ${w}`));
      if (receiptResult.fixedFields) {
        allFixedFields.receipt = receiptResult.fixedFields;
      }

      // Cross-validate: invoice and receipt currencies must match
      if (order.invoice.currencyCode && order.receipt.currencyCode) {
        if (order.invoice.currencyCode !== order.receipt.currencyCode) {
          allErrors.push(
            'Currency mismatch: Invoice and receipt must use the same currency',
          );
        }
      }

      // Cross-validate: receipt amount should match invoice amount
      if (order.invoice.amount && order.receipt.receiptAmount) {
        const diff = Math.abs(
          order.invoice.amount - order.receipt.receiptAmount,
        );
        if (diff > 0.01) {
          allWarnings.push(
            `Amount mismatch: Invoice (${order.invoice.amount}) vs Receipt (${order.receipt.receiptAmount})`,
          );
        }
      }
    }

    return {
      isValid: allErrors.length === 0,
      errors: allErrors,
      warnings: allWarnings,
      fixedFields:
        Object.keys(allFixedFields).length > 0 ? allFixedFields : undefined,
    };
  }

  /**
   * Auto-fix validation issues where possible
   */
  autoFix(payload: any, validationResult: ValidationResult): any {
    if (!validationResult.fixedFields) {
      return payload;
    }

    const fixed = { ...payload };

    // Apply all fixed fields
    for (const [key, value] of Object.entries(validationResult.fixedFields)) {
      if (key === 'lines' && Array.isArray(fixed.lines)) {
        // Fix line items
        for (const [lineIndex, lineFixed] of Object.entries(value)) {
          const currentLine = fixed.lines[parseInt(lineIndex)];
          if (
            currentLine &&
            typeof lineFixed === 'object' &&
            lineFixed !== null
          ) {
            fixed.lines[parseInt(lineIndex)] = {
              ...currentLine,
              ...(lineFixed as Record<string, any>),
            };
          }
        }
      } else {
        fixed[key] = value;
      }
    }

    return fixed;
  }

  /**
   * Sanitize payload for logging (remove sensitive data)
   */
  sanitizeForLogging(payload: any): any {
    const sanitized = { ...payload };

    // Remove or mask sensitive fields
    const sensitiveFields = [
      'customerEmail',
      'customerPhone',
      'password',
      'apiKey',
      'token',
    ];

    for (const field of sensitiveFields) {
      if (sanitized[field]) {
        sanitized[field] = '***REDACTED***';
      }
    }

    return sanitized;
  }
}
