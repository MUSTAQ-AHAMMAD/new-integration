/**
 * Oracle Customer Profile Service
 * 
 * Resolves customer IDs from account numbers by querying Oracle Fusion Customer Profile service.
 * 
 * Java Reference: FusionStdReceiptMapping.java
 * - Queries Oracle Customer Profile service to get customer ID from account number
 * - Customer ID is required for standard receipt processing
 */
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { OracleSoapClient, CustomerProfile } from './oracle-soap.client';

@Injectable()
export class OracleCustomerService {
  private readonly logger = new Logger(OracleCustomerService.name);
  private readonly customerCache = new Map<string, number>();
  private readonly profileCache = new Map<string, CustomerProfile>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly soapClient: OracleSoapClient,
  ) {}

  /**
   * Get customer ID from account number by querying Oracle Fusion.
   * 
   * Java equivalent: FusionCustomerProfileClient.getCustomerId(String accountNumber)
   * 
   * @param accountValue - Customer account number
   * @param region - Region code (e.g., "AE", "KW", "OM")
   * @returns Customer ID or null if not found
   * 
   * @example
   * const customerId = await customerService.getCustomerId("CUST-12345", "AE");
   * // Returns: 300000012345678
   */
  async getCustomerId(
    accountValue: string,
    region: string,
  ): Promise<number | null> {
    if (!accountValue) {
      return null;
    }

    // Check cache first
    const cacheKey = `${region}:${accountValue}`;
    if (this.customerCache.has(cacheKey)) {
      return this.customerCache.get(cacheKey)!;
    }

    try {
      // Call Oracle Customer Profile service SOAP API
      const profile = await this.soapClient.getCustomerProfile(accountValue);
      
      if (profile && profile.customerAccountId) {
        // Cache the customer ID
        this.customerCache.set(cacheKey, profile.customerAccountId);
        
        this.logger.debug(
          `Customer ID resolved for account ${accountValue} in region ${region}: ${profile.customerAccountId}`,
        );
        
        return profile.customerAccountId;
      }
      
      this.logger.debug(
        `No customer ID found for account ${accountValue} in region ${region}`,
      );
      
      return null;
    } catch (error) {
      this.logger.error(
        `Failed to fetch customer ID for account ${accountValue}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * Get customer profile details including customer ID and payment terms.
   * 
   * Java equivalent: FusionCustomerProfileClient.getCustomerProfile(String accountNumber)
   * 
   * @param accountValue - Customer account number
   * @param region - Region code (e.g., "AE", "KW", "OM")
   * @returns Customer profile or null if not found
   */
  async getCustomerProfile(
    accountValue: string,
    region: string,
  ): Promise<CustomerProfile | null> {
    if (!accountValue) {
      return null;
    }

    // Check profile cache first
    const cacheKey = `${region}:${accountValue}`;
    if (this.profileCache.has(cacheKey)) {
      return this.profileCache.get(cacheKey)!;
    }

    try {
      // Call Oracle Customer Profile service SOAP API
      const profile = await this.soapClient.getCustomerProfile(accountValue);
      
      if (profile && profile.customerAccountId) {
        // Cache the full profile
        this.profileCache.set(cacheKey, profile);
        
        // Also cache the customer ID separately
        this.customerCache.set(cacheKey, profile.customerAccountId);
        
        this.logger.debug(
          `Customer profile resolved for account ${accountValue} in region ${region}: ` +
          `ID=${profile.customerAccountId}, terms=${profile.paymentTermsName}`,
        );
        
        return profile;
      }
      
      this.logger.debug(
        `No customer profile found for account ${accountValue} in region ${region}`,
      );
      
      return null;
    } catch (error) {
      this.logger.error(
        `Failed to fetch customer profile for account ${accountValue}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * Clear all customer caches.
   * Useful when customer data changes in Oracle.
   */
  clearCache(): void {
    this.customerCache.clear();
    this.profileCache.clear();
    this.logger.log('Customer ID and profile caches cleared');
  }

  /**
   * Get cache statistics for both customer ID and profile caches.
   */
  getCacheStats(): { 
    customerIdCache: { size: number; keys: string[] };
    profileCache: { size: number; keys: string[] };
  } {
    return {
      customerIdCache: {
        size: this.customerCache.size,
        keys: Array.from(this.customerCache.keys()),
      },
      profileCache: {
        size: this.profileCache.size,
        keys: Array.from(this.profileCache.keys()),
      },
    };
  }
}
