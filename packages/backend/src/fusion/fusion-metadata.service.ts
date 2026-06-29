import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class FusionMetadataService {
  private readonly logger = new Logger(FusionMetadataService.name);
  private cache = new Map<string, any>();

  constructor(private readonly prisma: PrismaService) {}

  async getSalesMetadata(region: string): Promise<any> {
    // Check cache first
    if (this.cache.has(region)) {
      this.logger.debug(`Cache hit for region ${region}`);
      return this.cache.get(region);
    }

    this.logger.log(`Fetching FusionSalesMetadata for region: ${region}`);

    const metadata = await this.prisma.fusionSalesMetadata.findFirst({
      where: { region: region },
    });

    if (!metadata) {
      // Try fallback - get first available metadata
      this.logger.warn(
        `No metadata found for region ${region}, using fallback`,
      );
      const fallback = await this.prisma.fusionSalesMetadata.findFirst();
      if (fallback) {
        this.logger.log(
          `Using fallback metadata from region ${fallback.region}`,
        );
        this.cache.set(region, fallback);
        return fallback;
      }
      throw new Error(`No FusionSalesMetadata found for region ${region}`);
    }

    // Cache for 5 minutes
    this.cache.set(region, metadata);
    setTimeout(() => this.cache.delete(region), 5 * 60 * 1000);

    return metadata;
  }

  async getBusinessUnitMap(region: string): Promise<any> {
    return this.prisma.fusionBusinessUnitMap.findFirst({
      where: { region: region },
    });
  }

  async getReceiptMethod(region: string, methodName: string): Promise<any> {
    return this.prisma.fusionReceiptMethod.findFirst({
      where: {
        region: region,
        receiptMethodName: methodName,
      },
    });
  }

  async getJournalMeta(region: string): Promise<any> {
    return this.prisma.serviceProviderJournalMeta.findFirst({
      where: { region: region },
    });
  }

  clearCache() {
    this.cache.clear();
  }
}
