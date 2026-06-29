import {
  FusionAppDomain,
  FusionAppParams,
  FUSION_REST_API_VERSION,
} from './fusion-app-params';

describe('FusionAppDomain', () => {
  it('has the correct string values', () => {
    expect(FusionAppDomain.SCM).toBe('scm');
    expect(FusionAppDomain.FIN).toBe('fin');
  });
});

describe('FusionAppParams', () => {
  const params = new FusionAppParams('mycompany', 'us6');

  describe('buildBaseUrl', () => {
    it('constructs a valid Oracle Cloud base URL', () => {
      expect(params.buildBaseUrl()).toBe(
        'https://mycompany.fa.us6.oraclecloud.com',
      );
    });
  });

  describe('buildSoapBaseUrl', () => {
    it('returns the same value as buildBaseUrl', () => {
      expect(params.buildSoapBaseUrl()).toBe(params.buildBaseUrl());
    });
  });

  describe('buildSoapUrl', () => {
    it('appends the service name under /fscmService/', () => {
      expect(params.buildSoapUrl('RecInvoiceService')).toBe(
        'https://mycompany.fa.us6.oraclecloud.com/fscmService/RecInvoiceService',
      );
    });

    it('works for StandardReceiptService', () => {
      expect(params.buildSoapUrl('StandardReceiptService')).toBe(
        'https://mycompany.fa.us6.oraclecloud.com/fscmService/StandardReceiptService',
      );
    });

    it('works for JournalImportService', () => {
      expect(params.buildSoapUrl('JournalImportService')).toBe(
        'https://mycompany.fa.us6.oraclecloud.com/fscmService/JournalImportService',
      );
    });
  });

  describe('buildRestBaseUrl', () => {
    it('includes the default API version', () => {
      expect(params.buildRestBaseUrl()).toBe(
        `https://mycompany.fa.us6.oraclecloud.com/fscmRestApi/resources/${FUSION_REST_API_VERSION}`,
      );
    });

    it('accepts a custom API version', () => {
      expect(params.buildRestBaseUrl('11.13.18.06')).toBe(
        'https://mycompany.fa.us6.oraclecloud.com/fscmRestApi/resources/11.13.18.06',
      );
    });
  });

  describe('buildRestUrl', () => {
    it('builds a full resource URL with default version', () => {
      expect(params.buildRestUrl('customerProfiles')).toBe(
        `https://mycompany.fa.us6.oraclecloud.com/fscmRestApi/resources/${FUSION_REST_API_VERSION}/customerProfiles`,
      );
    });

    it('builds a full resource URL with custom version', () => {
      expect(params.buildRestUrl('inventoryItems', '11.13.18.06')).toBe(
        'https://mycompany.fa.us6.oraclecloud.com/fscmRestApi/resources/11.13.18.06/inventoryItems',
      );
    });
  });

  describe('fromCredential', () => {
    it('creates a FusionAppParams from a credential-like object', () => {
      const cred = { hostName: 'acme', server: 'fa' };
      const result = FusionAppParams.fromCredential(cred);
      expect(result).toBeInstanceOf(FusionAppParams);
      expect(result.buildBaseUrl()).toBe('https://acme.fa.fa.oraclecloud.com');
    });
  });

  describe('URL consistency', () => {
    it('all URL methods start with the base URL', () => {
      const base = params.buildBaseUrl();
      expect(params.buildSoapBaseUrl().startsWith(base)).toBe(true);
      expect(params.buildSoapUrl('SomeService').startsWith(base)).toBe(true);
      expect(params.buildRestBaseUrl().startsWith(base)).toBe(true);
      expect(params.buildRestUrl('someResource').startsWith(base)).toBe(true);
    });
  });
});
