/**
 * Integration tests for Oracle Customer, Tax, and UOM services
 *
 * These tests verify that the services can call the Oracle SOAP client
 * and handle responses correctly.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { OracleSoapClient } from './oracle-soap.client';
import { OracleCustomerService } from './oracle-customer.service';
import { OracleTaxService } from './oracle-tax.service';
import { OracleUomService } from './oracle-uom.service';

describe('Oracle Services Integration', () => {
  let customerService: OracleCustomerService;
  let taxService: OracleTaxService;
  let uomService: OracleUomService;
  let soapClient: OracleSoapClient;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OracleCustomerService,
        OracleTaxService,
        OracleUomService,
        {
          provide: OracleSoapClient,
          useValue: {
            getCustomerProfile: jest.fn(),
            getItemMaster: jest.fn(),
          },
        },
        {
          provide: PrismaService,
          useValue: {
            storeConfiguration: {
              findFirst: jest.fn(),
            },
            fusionInvoiceLine: {
              findFirst: jest.fn(),
            },
            fusionInvTxn: {
              findFirst: jest.fn(),
            },
          },
        },
      ],
    }).compile();

    customerService = module.get<OracleCustomerService>(OracleCustomerService);
    taxService = module.get<OracleTaxService>(OracleTaxService);
    uomService = module.get<OracleUomService>(OracleUomService);
    soapClient = module.get<OracleSoapClient>(OracleSoapClient);
  });

  describe('OracleCustomerService', () => {
    it('should be defined', () => {
      expect(customerService).toBeDefined();
    });

    it('should return null for empty account value', async () => {
      const result = await customerService.getCustomerId('', 'AE');
      expect(result).toBeNull();
    });

    it('should call SOAP client and return customer ID', async () => {
      jest.spyOn(soapClient, 'getCustomerProfile').mockResolvedValue({
        customerAccountId: 123456,
        paymentTermsName: 'NET30',
      });

      const result = await customerService.getCustomerId('CUST-001', 'AE');
      expect(result).toBe(123456);
      expect(soapClient.getCustomerProfile).toHaveBeenCalledWith('CUST-001');
    });

    it('should cache customer ID after first call', async () => {
      jest.spyOn(soapClient, 'getCustomerProfile').mockResolvedValue({
        customerAccountId: 123456,
        paymentTermsName: 'NET30',
      });

      await customerService.getCustomerId('CUST-001', 'AE');
      await customerService.getCustomerId('CUST-001', 'AE');

      expect(soapClient.getCustomerProfile).toHaveBeenCalledTimes(1);
    });

    it('should return null on SOAP error', async () => {
      jest
        .spyOn(soapClient, 'getCustomerProfile')
        .mockRejectedValue(new Error('SOAP fault'));

      const result = await customerService.getCustomerId('CUST-001', 'AE');
      expect(result).toBeNull();
    });
  });

  describe('OracleTaxService', () => {
    it('should be defined', () => {
      expect(taxService).toBeDefined();
    });

    it('should return null for undefined item number', async () => {
      const result = await taxService.getTaxClassificationCode(undefined, 'AE');
      expect(result).toBeNull();
    });

    it('should call SOAP client and return tax code', async () => {
      jest.spyOn(soapClient, 'getItemMaster').mockResolvedValue({
        itemNumber: 'ITEM-001',
        taxClassificationCode: 'VAT_STANDARD',
      });

      const result = await taxService.getTaxClassificationCode(
        'ITEM-001',
        'AE',
      );
      expect(result).toBe('VAT_STANDARD');
      expect(soapClient.getItemMaster).toHaveBeenCalledWith('ITEM-001');
    });

    it('should cache tax code after first call', async () => {
      jest.spyOn(soapClient, 'getItemMaster').mockResolvedValue({
        itemNumber: 'ITEM-001',
        taxClassificationCode: 'VAT_STANDARD',
      });

      await taxService.getTaxClassificationCode('ITEM-001', 'AE');
      await taxService.getTaxClassificationCode('ITEM-001', 'AE');

      expect(soapClient.getItemMaster).toHaveBeenCalledTimes(1);
    });

    it('should return null when item has no tax code', async () => {
      jest.spyOn(soapClient, 'getItemMaster').mockResolvedValue({
        itemNumber: 'ITEM-001',
      });

      const result = await taxService.getTaxClassificationCode(
        'ITEM-001',
        'AE',
      );
      expect(result).toBeNull();
    });
  });

  describe('OracleUomService', () => {
    it('should be defined', () => {
      expect(uomService).toBeDefined();
    });

    it('should return null for undefined item number', async () => {
      const result = await uomService.getUomCode(undefined, 'AE');
      expect(result).toBeNull();
    });

    it('should call SOAP client and return UOM code', async () => {
      jest.spyOn(soapClient, 'getItemMaster').mockResolvedValue({
        itemNumber: 'ITEM-001',
        uomCode: 'EA',
      });

      const result = await uomService.getUomCode('ITEM-001', 'AE');
      expect(result).toBe('EA');
      expect(soapClient.getItemMaster).toHaveBeenCalledWith('ITEM-001');
    });

    it('should cache UOM code after first call', async () => {
      jest.spyOn(soapClient, 'getItemMaster').mockResolvedValue({
        itemNumber: 'ITEM-001',
        uomCode: 'EA',
      });

      await uomService.getUomCode('ITEM-001', 'AE');
      await uomService.getUomCode('ITEM-001', 'AE');

      expect(soapClient.getItemMaster).toHaveBeenCalledTimes(1);
    });

    it('should return default "EA" when item has no UOM code', async () => {
      jest.spyOn(soapClient, 'getItemMaster').mockResolvedValue({
        itemNumber: 'ITEM-001',
      });

      const result = await uomService.getUomCode('ITEM-001', 'AE');
      expect(result).toBe('EA');
    });

    it('should return default "EA" on SOAP error', async () => {
      jest
        .spyOn(soapClient, 'getItemMaster')
        .mockRejectedValue(new Error('SOAP fault'));

      const result = await uomService.getUomCode('ITEM-001', 'AE');
      expect(result).toBe('EA');
    });
  });
});
