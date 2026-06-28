/**
 * Oracle UOM (Unit of Measure) Service
 * 
 * Fetches unit of measure codes from Oracle Fusion and caches them.
 * 
 * Java Reference: FusionInvoiceMapping.java lines 57-84
 * - Fetches UOM codes via Oracle UOM service
 * - Caches results in HashMap for performance
 */
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { OracleSoapClient } from './oracle-soap.client';

@Injectable()
export class OracleUomService {
  private readonly logger = new Logger(OracleUomService.name);
  private readonly uomCache = new Map<string, string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly soapClient: OracleSoapClient,
  ) {}

  /**
   * Get UOM code for a product item from Oracle Fusion.
   * 
   * Java equivalent: getUomCode(String itemNumber)
   * 
   * @param itemNumber - Product ID from VendHQ
   * @param region - Region code (e.g., "AE", "KW", "OM")
   * @returns UOM code (e.g., "EA", "EACH") or null if not found
   * 
   * @example
   * const uomCode = await uomService.getUomCode("PROD-12345", "AE");
   * // Returns: "EA"
   */
  async getUomCode(
    itemNumber: string | undefined,
    region: string,
  ): Promise<string | null> {
    if (!itemNumber) {
      return null;
    }

    // Check cache first
    const cacheKey = `${region}:${itemNumber}`;
    if (this.uomCache.has(cacheKey)) {
      return this.uomCache.get(cacheKey)!;
    }

    try {
      // First try to get from database cache (FusionInvTxn)
      const dbUomCode = await this.getFromDatabase(itemNumber, region);
      if (dbUomCode) {
        this.uomCache.set(cacheKey, dbUomCode);
        return dbUomCode;
      }

      // Call Oracle Item Master service to get UOM code
      const itemMaster = await this.soapClient.getItemMaster(itemNumber);
      
      if (itemMaster?.uomCode) {
        // Cache the result
        this.uomCache.set(cacheKey, itemMaster.uomCode);
        
        this.logger.debug(
          `UOM code resolved for item ${itemNumber} in region ${region}: ${itemMaster.uomCode}`,
        );
        
        return itemMaster.uomCode;
      }
      
      this.logger.debug(
        `No UOM code found for item ${itemNumber} in region ${region}, using default`,
      );
      
      // Return default UOM if not found
      const defaultUom = 'EA';
      this.uomCache.set(cacheKey, defaultUom);
      return defaultUom;
    } catch (error) {
      this.logger.error(
        `Failed to fetch UOM code for item ${itemNumber}: ${error instanceof Error ? error.message : String(error)}`,
      );
      // Return default on error
      return 'EA';
    }
  }

  /**
   * Get UOM code from database cache (FusionInvTxn).
   */
  private async getFromDatabase(
    itemNumber: string,
    region: string,
  ): Promise<string | null> {
    try {
      // Search recent FusionInvTxn records
      const invTxn = await this.prisma.fusionInvTxn.findFirst({
        where: {
          itemId: itemNumber,
          region,
          uomCode: { not: null },
        },
        select: { uomCode: true },
        orderBy: { createdAt: 'desc' },
      });

      return invTxn?.uomCode ?? null;
    } catch (error) {
      this.logger.warn(
        `Failed to query database for UOM code: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * Clear the UOM cache.
   * Useful when UOM codes change in Oracle.
   */
  clearCache(): void {
    this.uomCache.clear();
    this.logger.log('UOM cache cleared');
  }

  /**
   * Get cache statistics.
   */
  getCacheStats(): { size: number; keys: string[] } {
    return {
      size: this.uomCache.size,
      keys: Array.from(this.uomCache.keys()),
    };
  }
}
