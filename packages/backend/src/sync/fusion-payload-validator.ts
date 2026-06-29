/**
 * Fusion Payload Validator
 *
 * Validates Oracle Fusion SOAP payloads before sending to ensure all required fields are present
 * and properly formatted. Based on Java model validation logic.
 *
 * Java Reference:
 * - FusionSOAPClient/src/.../model/*.java
 * - IntegrationJobs/src/.../mapping/*.java
 */
import { Logger } from '@nestjs/common';
import {
  InvoiceHeader,
  InvoiceLine,
  StandardReceiptRequest,
  MiscReceiptRequest,
  ApplyReceiptRequest,
  JournalHeader,
  JournalLine,
} from '../clients/oracle/oracle-soap.client';

export class FusionPayloadValidator {
  private static readonly logger = new Logger(FusionPayloadValidator.name);

  /**
   * Validate InvoiceHeader payload
   * Java Reference: InvoiceHeader.java
   */
  static validateInvoiceHeader(invoice: InvoiceHeader): string[] {
    const errors: string[] = [];

    // Required string fields
    if (!invoice.billToCustomerName) {
      errors.push('billToCustomerName is required');
    }
    if (!invoice.billToLocation) {
      errors.push('billToLocation is required');
    }
    if (!invoice.billToAccountNumber) {
      errors.push('billToAccountNumber is required');
    }
    if (!invoice.businessUnit) {
      errors.push('businessUnit is required');
    }
    if (!invoice.transactionSource) {
      errors.push('transactionSource is required');
    }
    if (!invoice.transactionType) {
      errors.push('transactionType is required');
    }
    if (!invoice.invoiceCurrencyCode) {
      errors.push('invoiceCurrencyCode is required');
    }

    // Validate conversionRateType
    if (!invoice.conversionRateType) {
      errors.push('conversionRateType is required');
    } else if (!['Corporate', 'User'].includes(invoice.conversionRateType)) {
      errors.push(
        `conversionRateType must be "Corporate" or "User", got: ${invoice.conversionRateType}`,
      );
    }

    // Validate saleDate
    if (!invoice.saleDate) {
      errors.push('saleDate is required');
    } else if (
      !(invoice.saleDate instanceof Date) ||
      isNaN(invoice.saleDate.getTime())
    ) {
      errors.push('saleDate must be a valid Date object');
    }

    // Validate invoice lines
    if (!invoice.invoiceLines || invoice.invoiceLines.length === 0) {
      errors.push('At least one invoice line is required');
    } else {
      invoice.invoiceLines.forEach((line, idx) => {
        const lineErrors = this.validateInvoiceLine(line, idx + 1);
        errors.push(...lineErrors);
      });
    }

    return errors;
  }

  /**
   * Validate InvoiceLine payload
   * Java Reference: InvoiceLineModel.java
   */
  static validateInvoiceLine(line: InvoiceLine, lineNum: number): string[] {
    const errors: string[] = [];
    const prefix = `Line ${lineNum}:`;

    // Required fields
    if (!line.lineNumber || line.lineNumber <= 0) {
      errors.push(`${prefix} lineNumber must be > 0`);
    }
    if (!line.currencyCode) {
      errors.push(`${prefix} currencyCode is required`);
    }
    if (!line.salesOrder) {
      errors.push(`${prefix} salesOrder is required`);
    }

    // Quantity validation
    if (line.quantity === undefined || line.quantity === null) {
      errors.push(`${prefix} quantity is required`);
    } else if (line.quantity <= 0) {
      errors.push(`${prefix} quantity must be > 0`);
    }

    // Unit price validation
    if (line.unitSellingPrice === undefined || line.unitSellingPrice === null) {
      errors.push(`${prefix} unitSellingPrice is required`);
    } else if (line.unitSellingPrice < 0) {
      errors.push(`${prefix} unitSellingPrice must be >= 0`);
    }

    return errors;
  }

  /**
   * Validate StandardReceiptRequest payload
   * Java Reference: StandardReceiptRequest.java
   */
  static validateStandardReceipt(receipt: StandardReceiptRequest): string[] {
    const errors: string[] = [];

    // Required string fields
    if (!receipt.currencyCode) {
      errors.push('currencyCode is required');
    }
    if (!receipt.receiptNumber) {
      errors.push('receiptNumber is required');
    }
    if (!receipt.accountValue) {
      errors.push('accountValue is required');
    }

    // Required numeric fields
    if (!receipt.receiptMethodId || receipt.receiptMethodId <= 0) {
      errors.push('receiptMethodId must be > 0');
    }
    if (
      !receipt.remittanceBankAccountId ||
      receipt.remittanceBankAccountId <= 0
    ) {
      errors.push('remittanceBankAccountId must be > 0');
    }
    if (!receipt.orgId || receipt.orgId <= 0) {
      errors.push('orgId must be > 0');
    }

    // Receipt amount validation
    if (receipt.receiptAmount === undefined || receipt.receiptAmount === null) {
      errors.push('receiptAmount is required');
    } else if (receipt.receiptAmount <= 0) {
      errors.push('receiptAmount must be > 0');
    }

    // Validate saleDate
    if (!receipt.saleDate) {
      errors.push('saleDate is required');
    } else if (
      !(receipt.saleDate instanceof Date) ||
      isNaN(receipt.saleDate.getTime())
    ) {
      errors.push('saleDate must be a valid Date object');
    }

    return errors;
  }

  /**
   * Validate MiscReceiptRequest payload
   * Java Reference: MiscReceiptRequest.java
   */
  static validateMiscReceipt(receipt: MiscReceiptRequest): string[] {
    const errors: string[] = [];

    // Required string fields
    if (!receipt.currencyCode) {
      errors.push('currencyCode is required');
    }
    if (!receipt.receiptNumber) {
      errors.push('receiptNumber is required');
    }
    if (!receipt.receiptMethodName) {
      errors.push('receiptMethodName is required');
    }
    if (!receipt.bankAccountName) {
      errors.push('bankAccountName is required');
    }
    if (!receipt.receivableActivityName) {
      errors.push('receivableActivityName is required');
    }

    // Required numeric fields
    if (!receipt.receiptMethodId || receipt.receiptMethodId <= 0) {
      errors.push('receiptMethodId must be > 0');
    }
    if (!receipt.orgId || receipt.orgId <= 0) {
      errors.push('orgId must be > 0');
    }

    // Receipt amount validation (can be negative for adjustments)
    if (receipt.receiptAmount === undefined || receipt.receiptAmount === null) {
      errors.push('receiptAmount is required');
    }

    // Validate saleDate
    if (!receipt.saleDate) {
      errors.push('saleDate is required');
    } else if (
      !(receipt.saleDate instanceof Date) ||
      isNaN(receipt.saleDate.getTime())
    ) {
      errors.push('saleDate must be a valid Date object');
    }

    return errors;
  }

  /**
   * Validate ApplyReceiptRequest payload
   * Java Reference: ApplyReceiptRequest.java
   */
  static validateApplyReceipt(receipt: ApplyReceiptRequest): string[] {
    const errors: string[] = [];

    // Required string fields
    if (!receipt.transactionNumber) {
      errors.push(
        'transactionNumber is required (from invoice creation response)',
      );
    }
    if (!receipt.receiptNumber) {
      errors.push('receiptNumber is required');
    }
    if (!receipt.receiptCurrency) {
      errors.push('receiptCurrency is required');
    }
    if (!receipt.transactionSource) {
      errors.push('transactionSource is required');
    }

    // Amount validation
    if (receipt.amountApplied === undefined || receipt.amountApplied === null) {
      errors.push('amountApplied is required');
    } else if (receipt.amountApplied <= 0) {
      errors.push('amountApplied must be > 0');
    }

    // Validate receiptDate
    if (!receipt.receiptDate) {
      errors.push('receiptDate is required');
    } else if (
      !(receipt.receiptDate instanceof Date) ||
      isNaN(receipt.receiptDate.getTime())
    ) {
      errors.push('receiptDate must be a valid Date object');
    }

    return errors;
  }

  /**
   * Validate JournalHeader payload
   * Java Reference: JournalHeader.java
   */
  static validateJournalHeader(journal: JournalHeader): string[] {
    const errors: string[] = [];

    // Required string fields
    if (!journal.batchName) {
      errors.push('batchName is required');
    }
    if (!journal.accountingPeriodName) {
      errors.push('accountingPeriodName is required');
    }
    if (!journal.userSourceName) {
      errors.push('userSourceName is required');
    }
    if (!journal.userCategoryName) {
      errors.push('userCategoryName is required');
    }

    // Validate period name format (MMM-yy)
    if (
      journal.accountingPeriodName &&
      !/^[A-Z][a-z]{2}-\d{2}$/.test(journal.accountingPeriodName)
    ) {
      errors.push(
        `accountingPeriodName must be in format "MMM-yy" (e.g., "Jan-24"), got: ${journal.accountingPeriodName}`,
      );
    }

    // Required numeric fields
    if (!journal.ledgerId || journal.ledgerId <= 0) {
      errors.push('ledgerId must be > 0');
    }

    // Validate accountingDate
    if (!journal.accountingDate) {
      errors.push('accountingDate is required');
    } else if (
      !(journal.accountingDate instanceof Date) ||
      isNaN(journal.accountingDate.getTime())
    ) {
      errors.push('accountingDate must be a valid Date object');
    }

    // Validate journal lines
    if (!journal.journalLines || journal.journalLines.length === 0) {
      errors.push('At least one journal line is required');
    } else {
      journal.journalLines.forEach((line, idx) => {
        const lineErrors = this.validateJournalLine(line, idx + 1);
        errors.push(...lineErrors);
      });
    }

    return errors;
  }

  /**
   * Validate JournalLine payload
   * Java Reference: JournalLine.java
   */
  static validateJournalLine(line: JournalLine, lineNum: number): string[] {
    const errors: string[] = [];
    const prefix = `Line ${lineNum}:`;

    // Required fields
    if (!line.ledgerId || line.ledgerId <= 0) {
      errors.push(`${prefix} ledgerId must be > 0`);
    }
    if (!line.userJeSourceName) {
      errors.push(`${prefix} userJeSourceName is required`);
    }
    if (!line.jeCategoryName) {
      errors.push(`${prefix} jeCategoryName is required`);
    }
    if (!line.currencyCode) {
      errors.push(`${prefix} currencyCode is required`);
    }

    // Validate accountingDate
    if (!line.accountingDate) {
      errors.push(`${prefix} accountingDate is required`);
    } else if (
      !(line.accountingDate instanceof Date) ||
      isNaN(line.accountingDate.getTime())
    ) {
      errors.push(`${prefix} accountingDate must be a valid Date object`);
    }

    // Validate that either DR or CR amount is set, but not both
    const hasDr =
      line.enteredDrAmount !== undefined &&
      line.enteredDrAmount !== null &&
      line.enteredDrAmount !== 0;
    const hasCr =
      line.enteredCrAmount !== undefined &&
      line.enteredCrAmount !== null &&
      line.enteredCrAmount !== 0;

    if (!hasDr && !hasCr) {
      errors.push(
        `${prefix} Must have either enteredDrAmount or enteredCrAmount`,
      );
    }
    if (hasDr && hasCr) {
      errors.push(
        `${prefix} Cannot have both enteredDrAmount and enteredCrAmount`,
      );
    }

    return errors;
  }

  /**
   * Validate all payloads for a transaction
   */
  static validateTransaction(
    invoice: InvoiceHeader,
    standardReceipts: StandardReceiptRequest[],
    miscReceipts: MiscReceiptRequest[],
    applyReceipts: ApplyReceiptRequest[],
    journalHeaders: JournalHeader[],
  ): { valid: boolean; errors: Record<string, string[]> } {
    const allErrors: Record<string, string[]> = {};

    // Validate invoice
    const invoiceErrors = this.validateInvoiceHeader(invoice);
    if (invoiceErrors.length > 0) {
      allErrors.invoice = invoiceErrors;
    }

    // Validate standard receipts
    standardReceipts.forEach((receipt, idx) => {
      const errors = this.validateStandardReceipt(receipt);
      if (errors.length > 0) {
        allErrors[`standardReceipt[${idx}]`] = errors;
      }
    });

    // Validate misc receipts
    miscReceipts.forEach((receipt, idx) => {
      const errors = this.validateMiscReceipt(receipt);
      if (errors.length > 0) {
        allErrors[`miscReceipt[${idx}]`] = errors;
      }
    });

    // Validate apply receipts
    applyReceipts.forEach((receipt, idx) => {
      const errors = this.validateApplyReceipt(receipt);
      if (errors.length > 0) {
        allErrors[`applyReceipt[${idx}]`] = errors;
      }
    });

    // Validate journal headers
    journalHeaders.forEach((journal, idx) => {
      const errors = this.validateJournalHeader(journal);
      if (errors.length > 0) {
        allErrors[`journalHeader[${idx}]`] = errors;
      }
    });

    const valid = Object.keys(allErrors).length === 0;

    if (!valid) {
      this.logger.error(
        `Validation failed for transaction:`,
        JSON.stringify(allErrors, null, 2),
      );
    }

    return { valid, errors: allErrors };
  }

  /**
   * Log validation summary
   */
  static logValidationSummary(
    payloadType: string,
    errors: string[],
    payload: any,
  ): void {
    if (errors.length > 0) {
      this.logger.error(`${payloadType} validation failed:`);
      errors.forEach((error) => this.logger.error(`  - ${error}`));
      this.logger.debug(`Payload: ${JSON.stringify(payload, null, 2)}`);
    } else {
      this.logger.debug(`${payloadType} validation passed`);
    }
  }
}
