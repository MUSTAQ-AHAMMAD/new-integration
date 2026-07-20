import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FusionBusinessUnitMap } from '../database/entities/fusion-business-unit-map.entity';
import { FusionReceiptMethod } from '../database/entities/fusion-receipt-method.entity';
import { FusionSalesMetadata } from '../database/entities/fusion-sales-metadata.entity';
import { ServiceProviderJournalMeta } from '../database/entities/service-provider-journal-meta.entity';

@Injectable()
export class FusionMetadataService {
  private readonly logger = new Logger(FusionMetadataService.name);
  private cache = new Map<string, FusionSalesMetadata>();

  constructor(
    @InjectRepository(FusionSalesMetadata)
    private readonly salesMetadata: Repository<FusionSalesMetadata>,
    @InjectRepository(FusionBusinessUnitMap)
    private readonly businessUnitMap: Repository<FusionBusinessUnitMap>,
    @InjectRepository(FusionReceiptMethod)
    private readonly receiptMethod: Repository<FusionReceiptMethod>,
    @InjectRepository(ServiceProviderJournalMeta)
    private readonly journalMeta: Repository<ServiceProviderJournalMeta>,
  ) {}

  async getSalesMetadata(region: string): Promise<FusionSalesMetadata> {
    // Check cache first
    if (this.cache.has(region)) {
      this.logger.debug(`Cache hit for region ${region}`);
      return this.cache.get(region)!;
    }

    this.logger.log(`Fetching FusionSalesMetadata for region: ${region}`);

    const metadata = await this.salesMetadata.findOne({
      where: { region: region },
    });

    if (!metadata) {
      // Try fallback - get first available metadata
      this.logger.warn(
        `No metadata found for region ${region}, using fallback`,
      );
      const fallback = await this.salesMetadata.findOne({ where: {} });
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

  async getBusinessUnitMap(
    region: string,
  ): Promise<FusionBusinessUnitMap | null> {
    return this.businessUnitMap.findOne({
      where: { region: region },
    });
  }

  async getReceiptMethod(
    region: string,
    methodName: string,
  ): Promise<FusionReceiptMethod | null> {
    return this.receiptMethod.findOne({
      where: {
        region: region,
        receiptMethodName: methodName,
      },
    });
  }

  async getJournalMeta(
    region: string,
  ): Promise<ServiceProviderJournalMeta | null> {
    return this.journalMeta.findOne({
      where: { region: region },
    });
  }

  clearCache() {
    this.cache.clear();
  }
}
