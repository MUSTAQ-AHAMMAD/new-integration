/**
 * Oracle Tax Classification Service
 * 
 * Fetches tax classification codes from Oracle Fusion based on product configuration.
 * 
 * Java Reference: FusionInvoiceMapping.java
 * - Fetches tax codes based on product item configuration
 * - Determines tax applicability for invoice lines
 */
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { OracleSoapClient } from './oracle-soap.client';

@Injectable()
export class OracleTaxService {
  private readonly logger = new Logger(OracleTaxService.name);
  private readonly taxCache = new Map<string, string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly soapClient: OracleSoapClient,
  ) {}

  /**
   * Get tax classification code for a product item from Oracle Fusion.
   * 
   * Java equivalent: getTaxClassificationCode(String itemNumber)
   * 
   * @param itemNumber - Product ID from VendHQ
   * @param region - Region code (e.g., "AE", "KW", "OM")
   * @returns Tax classification code or null if not found/not taxable
   * 
   * @example
   * const taxCode = await taxService.getTaxClassificationCode("PROD-12345", "AE");
   * // Returns: "VAT_STANDARD" or null
   */
  async getTaxClassificationCode(
    itemNumber: string | undefined,
    region: string,
  ): Promise<string | null> {
    if (!itemNumber) {
      return null;
    }

    // Check cache first
    const cacheKey = `${region}:${itemNumber}`;
    if (this.taxCache.has(cacheKey)) {
      return this.taxCache.get(cacheKey)!;
    }

    try {
      // First try to get from database cache (FusionInvoiceLine or StoreConfiguration)
      const dbTaxCode = await this.getFromDatabase(itemNumber, region);
      if (dbTaxCode) {
        this.taxCache.set(cacheKey, dbTaxCode);
        return dbTaxCode;
      }

      // Call Oracle Item Master service to get tax classification
      const itemMaster = await this.soapClient.getItemMaster(itemNumber);
      
      if (itemMaster?.taxClassificationCode) {
        // Cache the result
        this.taxCache.set(cacheKey, itemMaster.taxClassificationCode);
        
        this.logger.debug(
          `Tax code resolved for item ${itemNumber} in region ${region}: ${itemMaster.taxClassificationCode}`,
        );
        
        return itemMaster.taxClassificationCode;
      }
      
      this.logger.debug(
        `No tax code found for item ${itemNumber} in region ${region}`,
      );
      
      return null;
    } catch (error) {
      this.logger.error(
        `Failed to fetch tax code for item ${itemNumber}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * Get tax code from database cache (StoreConfiguration or previous FusionInvoiceLine).
   */
  private async getFromDatabase(
    itemNumber: string,
    region: string,
  ): Promise<string | null> {
    try {
      // Try to find from StoreConfiguration first
      const storeConfig = await this.prisma.storeConfiguration.findFirst({
        where: { region },
        select: { taxClassificationCode: true },
      });
      
      if (storeConfig?.taxClassificationCode) {
        return storeConfig.taxClassificationCode;
      }

      // Fall back to searching recent FusionInvoiceLine records
      const invoiceLine = await this.prisma.fusionInvoiceLine.findFirst({
        where: {
          itemNumber,
          region,
          taxCode: { not: null },
        },
        select: { taxCode: true },
        orderBy: { createdAt: 'desc' },
      });

      return invoiceLine?.taxCode ?? null;
    } catch (error) {
      this.logger.warn(
        `Failed to query database for tax code: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * Clear the tax code cache.
   * Useful when tax configurations change in Oracle.
   */
  clearCache(): void {
    this.taxCache.clear();
    this.logger.log('Tax code cache cleared');
  }

  /**
   * Get cache statistics.
   */
  getCacheStats(): { size: number; keys: string[] } {
    return {
      size: this.taxCache.size,
      keys: Array.from(this.taxCache.keys()),
    };
  }
}
