/**
 * Debug Oracle Invoice Creation - Comprehensive diagnostic tool
 *
 * This script helps diagnose Oracle Status E errors by:
 * 1. Analyzing failed orders in the sync queue
 * 2. Validating all required fields
 * 3. Showing the exact SOAP payload that would be sent
 * 4. Attempting invoice creation with detailed error reporting
 * 5. Providing actionable recommendations
 *
 * Usage:
 *   # Analyze the most recent failed order
 *   npm run debug:oracle
 *
 *   # Analyze a specific order by ID
 *   npm run debug:oracle -- --orderId=12345 --branch=CCNTRBHR
 *
 *   # Dry run (don't actually call Oracle)
 *   npm run debug:oracle -- --dryRun
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { PrismaService } from '../prisma/prisma.service';
import { OdooTransformationService } from '../sync/odoo-transformation.service';
import { OracleSoapClient } from '../clients/oracle/oracle-soap.client';
import { StoreConfigService } from '../store-config/store-config.service';

interface DebugOptions {
  odooOrderId?: string;
  branchCode?: string;
  dryRun?: boolean;
  showXml?: boolean;
}

interface ValidationIssue {
  field: string;
  severity: 'ERROR' | 'WARNING';
  message: string;
  recommendation?: string;
}

class OracleInvoiceDebugger {
  constructor(
    private readonly prisma: PrismaService,
    private readonly transformation: OdooTransformationService,
    private readonly soapClient: OracleSoapClient,
    private readonly storeConfigService: StoreConfigService,
  ) {}

  async run(options: DebugOptions = {}) {
    console.log(
      '╔══════════════════════════════════════════════════════════════╗',
    );
    console.log(
      '║   Oracle Invoice Debug Tool - Status E Diagnostic           ║',
    );
    console.log(
      '╚══════════════════════════════════════════════════════════════╝\n',
    );

    try {
      // Step 1: Find the order to debug
      const order = await this.findOrder(options);
      if (!order) {
        console.log('❌ No failed orders found to debug');
        return;
      }

      console.log('📋 Order Selected for Analysis:');
      console.log(
        '─────────────────────────────────────────────────────────────',
      );
      this.printOrderSummary(order);

      // Step 2: Get backup data
      const backupOrder = await this.getBackupOrder(order.odooOrderId);
      if (!backupOrder) {
        console.log('\n❌ Backup order not found in BackupOdooOrder table');
        console.log('   This order may not have been backed up properly.');
        return;
      }

      console.log('\n✅ Backup order found');
      console.log(`   - Lines: ${backupOrder.orderLines.length}`);
      console.log(`   - Payments: ${backupOrder.orderPayments.length}`);
      console.log(`   - Order Date: ${String(backupOrder.dateOrder)}`);
      console.log(`   - Amount Total: ${backupOrder.amountTotal}`);

      // Step 3: Get and validate store configuration
      const storeConfig = await this.getStoreConfig(order.branchCode);
      if (!storeConfig) {
        console.log('\n❌ Store configuration not found');
        return;
      }

      console.log('\n📍 Store Configuration:');
      console.log(
        '─────────────────────────────────────────────────────────────',
      );
      this.printStoreConfig(storeConfig);

      // Step 4: Transform to invoice payload
      console.log('\n🔄 Transforming order to Oracle invoice payload...');
      const payloads = await this.transformation.buildOrderPayloads(
        backupOrder.id,
        order.branchCode,
        storeConfig.region || 'AE',
      );

      console.log('\n📦 Invoice Header Generated:');
      console.log(
        '─────────────────────────────────────────────────────────────',
      );
      this.printInvoiceHeader(payloads.invoiceHeader);

      // Step 5: Validate all fields
      console.log('\n🔍 Field Validation:');
      console.log(
        '─────────────────────────────────────────────────────────────',
      );
      const validationIssues = this.validateInvoiceHeader(
        payloads.invoiceHeader,
      );
      this.printValidationIssues(validationIssues);

      // Step 6: Show SOAP XML if requested
      if (options.showXml) {
        console.log('\n📄 SOAP XML Request Preview:');
        console.log(
          '─────────────────────────────────────────────────────────────',
        );
        this.printSoapPreview(payloads.invoiceHeader);
      }

      // Step 7: Check for common issues
      console.log('\n⚠️  Common Issue Checks:');
      console.log(
        '─────────────────────────────────────────────────────────────',
      );
      await this.checkCommonIssues(order, storeConfig, payloads.invoiceHeader);

      // Step 8: Attempt invoice creation (if not dry run)
      if (!options.dryRun) {
        console.log('\n🚀 Attempting Invoice Creation...');
        console.log(
          '─────────────────────────────────────────────────────────────',
        );
        await this.attemptInvoiceCreation(
          payloads.invoiceHeader,
          order.odooOrderId,
        );
      } else {
        console.log('\n🔒 DRY RUN MODE - Skipping actual Oracle API call');
        console.log('   Remove --dryRun flag to attempt real invoice creation');
      }

      // Step 9: Recommendations
      console.log('\n💡 Recommendations:');
      console.log(
        '─────────────────────────────────────────────────────────────',
      );
      this.printRecommendations(validationIssues, order);
    } catch (error) {
      console.error('\n❌ Debug script failed with error:');
      console.error(error);
    }
  }

  private async findOrder(options: DebugOptions) {
    if (options.odooOrderId && options.branchCode) {
      return this.prisma.orderSyncQueue.findUnique({
        where: {
          odooOrderId_branchCode: {
            odooOrderId: options.odooOrderId,
            branchCode: options.branchCode,
          },
        },
      });
    }

    // Find most recent failed order with Status E error
    const failedTransactions = await this.prisma.failedTransaction.findMany({
      where: {
        errorMessage: { contains: 'Status E' },
        orderSyncQueueId: { not: null },
      },
      orderBy: { createdAt: 'desc' },
      take: 1,
      include: { orderSyncQueue: true },
    });

    return failedTransactions[0]?.orderSyncQueue || null;
  }

  private async getBackupOrder(odooOrderId: string) {
    return this.prisma.backupOdooOrder.findFirst({
      where: { orderId: parseInt(odooOrderId) },
      include: { orderLines: true, orderPayments: true },
    });
  }

  private async getStoreConfig(branchCode: string) {
    return this.prisma.storeConfiguration.findUnique({
      where: { branchCode },
    });
  }

  private printOrderSummary(order: any) {
    console.log(`   Odoo Order ID: ${order.odooOrderId}`);
    console.log(`   Order Number: ${order.odooOrderNumber}`);
    console.log(`   Branch Code: ${order.branchCode}`);
    console.log(`   Region: ${order.region || 'N/A'}`);
    console.log(`   Status: ${order.status}`);
    console.log(`   Sync Attempts: ${order.syncAttempts}`);
    console.log(`   Total Amount: ${order.totalAmount} ${order.currency}`);
    console.log(`   Order Date: ${order.orderDate.toISOString()}`);
    console.log(`   Is Paid: ${order.isPaid}`);
    console.log(`   Is Cancelled: ${order.isCancelled}`);
    if (order.lastErrorMessage) {
      console.log(
        `   Last Error: ${order.lastErrorMessage.substring(0, 200)}...`,
      );
    }
  }

  private printStoreConfig(config: any) {
    console.log(`   Branch Code: ${config.branchCode}`);
    console.log(`   Bill To Site: ${config.billToSiteName}`);
    console.log(`   Bill To Location: ${config.billToLocation || 'NOT SET'}`);
    console.log(`   Operating Unit ID: ${config.oracleOperatingUnitId}`);
    console.log(`   Business Unit: ${config.oracleBusinessUnit}`);
    console.log(`   Transaction Source: ${config.transactionSource}`);
    console.log(`   Transaction Type: ${config.transactionType}`);
    console.log(`   Currency Code: ${config.invoiceCurrencyCode}`);
    console.log(`   Is Active: ${config.isActive}`);
    console.log(`   Validation Status: ${config.validationStatus}`);
    if (config.validationErrors) {
      console.log(
        `   Validation Errors: ${JSON.stringify(config.validationErrors)}`,
      );
    }
  }

  private printInvoiceHeader(header: any) {
    console.log(`   billToCustomerName: "${header.billToCustomerName}"`);
    console.log(`   billToLocation: "${header.billToLocation}"`);
    console.log(`   billToAccountNumber: "${header.billToAccountNumber}"`);
    console.log(`   businessUnit: "${header.businessUnit}"`);
    console.log(`   transactionSource: "${header.transactionSource}"`);
    console.log(`   transactionType: "${header.transactionType}"`);
    console.log(`   trxDate: ${header.trxDate || header.saleDate}`);
    console.log(`   saleDate (GlDate): ${header.saleDate}`);
    console.log(`   invoiceCurrencyCode: "${header.invoiceCurrencyCode}"`);
    console.log(`   conversionRateType: "${header.conversionRateType}"`);
    console.log(`   conversionRate: ${header.conversionRate || 'NOT SET'}`);
    console.log(`   conversionDate: ${header.conversionDate || 'NOT SET'}`);
    console.log(`   Invoice Lines: ${header.invoiceLines.length}`);

    if (header.invoiceLines.length > 0) {
      console.log('\n   Sample Line Items:');
      header.invoiceLines.slice(0, 3).forEach((line: any, i: number) => {
        console.log(`     Line ${i + 1}:`);
        console.log(`       - Description: ${line.description || 'N/A'}`);
        console.log(`       - Quantity: ${line.quantity}`);
        console.log(`       - Unit Price: ${line.unitSellingPrice}`);
        console.log(`       - Sales Order: ${line.salesOrder || 'N/A'}`);
        console.log(`       - Item Number: ${line.itemNumber || 'N/A'}`);
        console.log(
          `       - Tax Code: ${line.taxClassificationCode || 'N/A'}`,
        );
      });
      if (header.invoiceLines.length > 3) {
        console.log(
          `     ... and ${header.invoiceLines.length - 3} more lines`,
        );
      }
    }
  }

  private validateInvoiceHeader(header: any): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    // Critical required fields
    if (!header.billToCustomerName || header.billToCustomerName.trim() === '') {
      issues.push({
        field: 'billToCustomerName',
        severity: 'ERROR',
        message: 'Missing or empty',
        recommendation: 'Set billToSiteName in StoreConfiguration',
      });
    }

    if (!header.billToLocation || header.billToLocation.trim() === '') {
      issues.push({
        field: 'billToLocation',
        severity: 'ERROR',
        message: 'Missing or empty',
        recommendation: 'Set billToLocation in StoreConfiguration',
      });
    }

    if (
      !header.billToAccountNumber ||
      header.billToAccountNumber.trim() === ''
    ) {
      issues.push({
        field: 'billToAccountNumber',
        severity: 'ERROR',
        message: 'Missing or empty',
        recommendation: 'Set oracleOperatingUnitId in StoreConfiguration',
      });
    }

    if (!header.businessUnit || header.businessUnit.trim() === '') {
      issues.push({
        field: 'businessUnit',
        severity: 'ERROR',
        message: 'Missing or empty',
        recommendation: 'Set oracleBusinessUnit in StoreConfiguration',
      });
    }

    if (!header.transactionSource || header.transactionSource.trim() === '') {
      issues.push({
        field: 'transactionSource',
        severity: 'ERROR',
        message: 'Missing or empty',
        recommendation: 'Set transactionSource in StoreConfiguration',
      });
    }

    if (!header.transactionType || header.transactionType.trim() === '') {
      issues.push({
        field: 'transactionType',
        severity: 'ERROR',
        message: 'Missing or empty',
        recommendation: 'Set transactionType in StoreConfiguration',
      });
    }

    if (
      !header.invoiceCurrencyCode ||
      header.invoiceCurrencyCode.trim() === ''
    ) {
      issues.push({
        field: 'invoiceCurrencyCode',
        severity: 'ERROR',
        message: 'Missing or empty',
        recommendation: 'Set invoiceCurrencyCode in StoreConfiguration',
      });
    }

    if (!header.conversionRateType || header.conversionRateType.trim() === '') {
      issues.push({
        field: 'conversionRateType',
        severity: 'ERROR',
        message: 'Missing or empty',
        recommendation: 'Should default to "Corporate"',
      });
    }

    if (!header.saleDate) {
      issues.push({
        field: 'saleDate (GlDate)',
        severity: 'ERROR',
        message: 'Missing date',
        recommendation: 'Check order.dateOrder in backup table',
      });
    }

    if (!header.trxDate && !header.saleDate) {
      issues.push({
        field: 'trxDate',
        severity: 'ERROR',
        message: 'Missing date',
        recommendation: 'Should default to saleDate',
      });
    }

    if (!header.invoiceLines || header.invoiceLines.length === 0) {
      issues.push({
        field: 'invoiceLines',
        severity: 'ERROR',
        message: 'No invoice lines',
        recommendation: 'Check BackupOdooOrderLine records',
      });
    }

    // Warnings
    if (header.conversionRate === undefined || header.conversionRate === null) {
      issues.push({
        field: 'conversionRate',
        severity: 'WARNING',
        message: 'Not set',
        recommendation: 'Should default to 1 for Corporate rate type',
      });
    }

    if (!header.conversionDate) {
      issues.push({
        field: 'conversionDate',
        severity: 'WARNING',
        message: 'Not set',
        recommendation: 'Should default to transaction date',
      });
    }

    // Validate line items
    header.invoiceLines?.forEach((line: any, index: number) => {
      if (!line.lineNumber) {
        issues.push({
          field: `invoiceLines[${index}].lineNumber`,
          severity: 'ERROR',
          message: 'Missing line number',
        });
      }
      if (!line.quantity || line.quantity === 0) {
        issues.push({
          field: `invoiceLines[${index}].quantity`,
          severity: 'WARNING',
          message: 'Zero or missing quantity',
        });
      }
      if (!line.salesOrder) {
        issues.push({
          field: `invoiceLines[${index}].salesOrder`,
          severity: 'WARNING',
          message: 'Missing sales order reference',
        });
      }
    });

    return issues;
  }

  private printValidationIssues(issues: ValidationIssue[]) {
    const errors = issues.filter((i) => i.severity === 'ERROR');
    const warnings = issues.filter((i) => i.severity === 'WARNING');

    if (errors.length === 0 && warnings.length === 0) {
      console.log('✅ All required fields present and valid');
      return;
    }

    if (errors.length > 0) {
      console.log(`\n❌ ERRORS (${errors.length}):`);
      errors.forEach((issue) => {
        console.log(`   • ${issue.field}: ${issue.message}`);
        if (issue.recommendation) {
          console.log(`     → ${issue.recommendation}`);
        }
      });
    }

    if (warnings.length > 0) {
      console.log(`\n⚠️  WARNINGS (${warnings.length}):`);
      warnings.forEach((issue) => {
        console.log(`   • ${issue.field}: ${issue.message}`);
        if (issue.recommendation) {
          console.log(`     → ${issue.recommendation}`);
        }
      });
    }
  }

  private printSoapPreview(header: any) {
    console.log('   <typ:createSimpleInvoice>');
    console.log('     <typ:invoice>');
    console.log(
      `       <typ1:BillToCustomerName>${header.billToCustomerName}</typ1:BillToCustomerName>`,
    );
    console.log(
      `       <typ1:BillToLocation>${header.billToLocation}</typ1:BillToLocation>`,
    );
    console.log(
      `       <typ1:BusinessUnit>${header.businessUnit}</typ1:BusinessUnit>`,
    );
    console.log(
      `       <typ1:TransactionSource>${header.transactionSource}</typ1:TransactionSource>`,
    );
    console.log(
      `       <typ1:TransactionType>${header.transactionType}</typ1:TransactionType>`,
    );
    console.log(
      `       <typ1:TrxDate>${header.trxDate || header.saleDate}</typ1:TrxDate>`,
    );
    console.log(
      `       <typ1:InvoiceCurrencyCode>${header.invoiceCurrencyCode}</typ1:InvoiceCurrencyCode>`,
    );
    console.log('       <!-- ... invoice lines ... -->');
    console.log('     </typ:invoice>');
    console.log('   </typ:createSimpleInvoice>');
  }

  private async checkCommonIssues(order: any, storeConfig: any, _header: any) {
    const issues: string[] = [];

    // Check if business unit might be invalid
    if (
      storeConfig.oracleBusinessUnit?.includes('placeholder') ||
      storeConfig.oracleBusinessUnit?.includes('FIXME')
    ) {
      issues.push('⚠️  Business Unit appears to be a placeholder value');
    }

    // Check if transaction source/type might be invalid
    if (
      storeConfig.transactionSource?.includes('placeholder') ||
      storeConfig.transactionType?.includes('placeholder')
    ) {
      issues.push(
        '⚠️  Transaction Source/Type appears to be placeholder values',
      );
    }

    // Check if store config was auto-created
    if (
      storeConfig.validationStatus === 'PENDING' ||
      storeConfig.validationStatus === 'PARTIAL'
    ) {
      issues.push(
        '⚠️  Store configuration was auto-created and needs manual validation',
      );
    }

    // Check for very old orders (Oracle might reject)
    const orderAge = Date.now() - new Date(order.orderDate).getTime();
    const daysOld = Math.floor(orderAge / (1000 * 60 * 60 * 24));
    if (daysOld > 90) {
      issues.push(
        `⚠️  Order is ${daysOld} days old - Oracle may reject old transactions`,
      );
    }

    // Check for missing region mapping
    if (!storeConfig.region) {
      issues.push(
        '⚠️  StoreConfig has no region set - may affect receipt creation',
      );
    }

    // Check if similar orders succeeded
    const similarSucceeded = await this.prisma.orderSyncQueue.findFirst({
      where: {
        branchCode: order.branchCode,
        status: 'SYNCED',
      },
      orderBy: { updatedAt: 'desc' },
    });

    if (!similarSucceeded) {
      issues.push(
        '⚠️  No successful syncs found for this branch - may indicate branch-level config issue',
      );
    }

    if (issues.length === 0) {
      console.log('✅ No common issues detected');
    } else {
      issues.forEach((issue) => console.log(issue));
    }
  }

  private async attemptInvoiceCreation(header: any, _orderId: string) {
    console.log('⏳ Calling Oracle API...');
    console.log('   (Check backend logs for full SOAP XML request/response)\n');

    try {
      const result = await this.soapClient.createSimpleInvoice(header);

      console.log('✅ SUCCESS! Invoice created successfully\n');
      console.log('   Service Status:', result.serviceStatus);
      console.log('   Transaction Number:', result.transactionNumber);
      console.log('   Customer Trx ID:', result.customerTrxId);

      console.log('\n📊 This means:');
      console.log('   • The SOAP request was valid');
      console.log('   • Oracle accepted all field values');
      console.log('   • The invoice was created in Oracle EBS');
      console.log(
        '\n💡 If this succeeded in the debug script but fails in production,',
      );
      console.log(
        '   the issue may be with the data transformation or order enrichment.',
      );
    } catch (error: any) {
      console.log('❌ FAILED! Oracle returned an error\n');
      console.log('   Error Message:', error.message);

      console.log('\n📊 Error Analysis:');
      if (error.message.includes('Status E')) {
        console.log('   • Oracle rejected the invoice with Status E');
        console.log('   • Check the error message above for specific details');
        console.log(
          '   • The full SOAP XML response should be in backend logs',
        );
      } else if (error.message.includes('timeout')) {
        console.log(
          '   • Request timed out - Oracle may be slow or unreachable',
        );
      } else if (error.message.includes('ECONNREFUSED')) {
        console.log('   • Cannot connect to Oracle SOAP endpoint');
        console.log('   • Check ORACLE_SOAP_BASE_URL in .env');
      } else if (
        error.message.includes('401') ||
        error.message.includes('Unauthorized')
      ) {
        console.log('   • Authentication failed');
        console.log('   • Check ORACLE_USERNAME and ORACLE_PASSWORD in .env');
      } else {
        console.log('   • Unexpected error type');
      }

      console.log('\n🔍 Next Steps:');
      console.log(
        '   1. Check backend logs for full SOAP request/response XML',
      );
      console.log(
        '   2. Look for "⚠️  Status E detected" or "FULL Response XML"',
      );
      console.log('   3. Compare the error with Oracle EBS error messages');
      console.log('   4. Verify the field values against Oracle setup');
    }
  }

  private printRecommendations(
    validationIssues: ValidationIssue[],
    order: any,
  ) {
    const errors = validationIssues.filter((i) => i.severity === 'ERROR');

    if (errors.length > 0) {
      console.log('1️⃣  Fix the validation errors listed above');
      console.log(
        '   These are blocking issues that will prevent invoice creation\n',
      );
    }

    console.log('2️⃣  Check backend logs for detailed SOAP XML:');
    console.log('   pm2 logs backend | grep -A 50 "Status E"\n');

    console.log('3️⃣  Verify Oracle EBS setup:');
    console.log('   • Business Unit exists and is active');
    console.log('   • Transaction Source is registered in AR setup');
    console.log('   • Transaction Type is valid for this Business Unit');
    console.log('   • Customer account exists and is active\n');

    console.log('4️⃣  Query similar successful orders:');
    console.log(`   SELECT * FROM "FusionInvoiceHeader"`);
    console.log(
      `   WHERE status = 'SUCCESS' AND region = '${order.region || 'AE'}'`,
    );
    console.log('   LIMIT 5;\n');

    console.log('5️⃣  Update store configuration if needed:');
    console.log(`   UPDATE "StoreConfiguration"`);
    console.log(`   SET <field> = '<correct_value>'`);
    console.log(`   WHERE "branchCode" = '${order.branchCode}';\n`);

    console.log('6️⃣  Retry the order after fixing:');
    console.log('   curl -X POST http://localhost:3000/sync/orders/retry \\');
    console.log('     -H "Content-Type: application/json" \\');
    console.log(
      '     -d \'{"odooOrderId":"' +
        order.odooOrderId +
        '","branchCode":"' +
        order.branchCode +
        '"}\'',
    );
  }
}

async function main() {
  const args = process.argv.slice(2);
  const options: DebugOptions = {
    dryRun: args.includes('--dryRun') || args.includes('--dry-run'),
    showXml: args.includes('--showXml') || args.includes('--xml'),
  };

  // Parse orderId and branchCode
  args.forEach((arg) => {
    if (arg.startsWith('--orderId=')) {
      options.odooOrderId = arg.split('=')[1];
    }
    if (arg.startsWith('--branch=') || arg.startsWith('--branchCode=')) {
      options.branchCode = arg.split('=')[1];
    }
  });

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'], // Reduce noise during debug
  });

  const prisma = app.get(PrismaService);
  const transformation = app.get(OdooTransformationService);
  const soapClient = app.get(OracleSoapClient);
  const storeConfigService = app.get(StoreConfigService);

  const invoiceDebugger = new OracleInvoiceDebugger(
    prisma,
    transformation,
    soapClient,
    storeConfigService,
  );

  await invoiceDebugger.run(options);
  await app.close();
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
