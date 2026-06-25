import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { FusionCredentialResolver } from './fusion-credential.resolver';
import { FUSION_REST_API_VERSION } from '../../utils/fusion-app-params';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDbCredential(overrides: Partial<{
  hostName: string;
  server: string;
  username: string;
  password: string;
}> = {}) {
  return {
    hostName: 'mycompany',
    server: 'us6',
    username: 'oracle_user',
    password: 'oracle_pass',
    ...overrides,
  };
}

function makePrisma(credential: ReturnType<typeof makeDbCredential> | null = makeDbCredential()) {
  return {
    fusionCredential: {
      findFirst: jest.fn().mockResolvedValue(credential),
    },
  } as unknown as PrismaService;
}

function makeConfigService(overrides: Record<string, string> = {}) {
  const defaults: Record<string, string> = {
    ORACLE_SOAP_BASE_URL: '',
    ORACLE_REST_BASE_URL: '',
    ORACLE_USERNAME: '',
    ORACLE_PASSWORD: '',
    ...overrides,
  };
  return {
    get: jest.fn().mockImplementation((key: string, fallback = '') =>
      defaults[key] ?? fallback,
    ),
  } as unknown as ConfigService;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FusionCredentialResolver', () => {
  describe('resolveOracleConnectionSettings — DB credential present', () => {
    let resolver: FusionCredentialResolver;

    beforeEach(() => {
      resolver = new FusionCredentialResolver(
        makePrisma(makeDbCredential()),
        makeConfigService(),
      );
    });

    it('returns source="database"', async () => {
      const settings = await resolver.resolveOracleConnectionSettings();
      expect(settings?.source).toBe('database');
    });

    it('builds the correct SOAP base URL from hostname + server', async () => {
      const settings = await resolver.resolveOracleConnectionSettings();
      expect(settings?.soapBaseUrl).toBe(
        'https://mycompany.fa.us6.oraclecloud.com',
      );
    });

    it('builds the correct REST base URL including the API version', async () => {
      const settings = await resolver.resolveOracleConnectionSettings();
      expect(settings?.restBaseUrl).toBe(
        `https://mycompany.fa.us6.oraclecloud.com/fscmRestApi/resources/${FUSION_REST_API_VERSION}`,
      );
    });

    it('exposes plain-text username and password', async () => {
      const settings = await resolver.resolveOracleConnectionSettings();
      expect(settings?.username).toBe('oracle_user');
      expect(settings?.password).toBe('oracle_pass');
    });

    it('produces a valid Basic-Auth authorization header', async () => {
      const settings = await resolver.resolveOracleConnectionSettings();
      const expected = `Basic ${Buffer.from('oracle_user:oracle_pass').toString('base64')}`;
      expect(settings?.authorizationHeader).toBe(expected);
    });
  });

  describe('resolveOracleConnectionSettings — no active DB credential', () => {
    let resolver: FusionCredentialResolver;

    beforeEach(() => {
      resolver = new FusionCredentialResolver(
        makePrisma(null),
        makeConfigService({
          ORACLE_SOAP_BASE_URL: 'https://oracle-env.example.com',
          ORACLE_REST_BASE_URL: 'https://oracle-env.example.com/rest',
          ORACLE_USERNAME: 'env_user',
          ORACLE_PASSWORD: 'env_pass',
        }),
      );
    });

    it('returns source="environment"', async () => {
      const settings = await resolver.resolveOracleConnectionSettings();
      expect(settings?.source).toBe('environment');
    });

    it('returns the env-var SOAP base URL', async () => {
      const settings = await resolver.resolveOracleConnectionSettings();
      expect(settings?.soapBaseUrl).toBe('https://oracle-env.example.com');
    });

    it('returns the env-var REST base URL', async () => {
      const settings = await resolver.resolveOracleConnectionSettings();
      expect(settings?.restBaseUrl).toBe(
        'https://oracle-env.example.com/rest',
      );
    });

    it('produces correct Basic-Auth header from env credentials', async () => {
      const settings = await resolver.resolveOracleConnectionSettings();
      const expected = `Basic ${Buffer.from('env_user:env_pass').toString('base64')}`;
      expect(settings?.authorizationHeader).toBe(expected);
    });
  });

  describe('resolveOracleConnectionSettings — no credentials at all', () => {
    it('returns null when neither DB nor env vars are configured', async () => {
      const resolver = new FusionCredentialResolver(
        makePrisma(null),
        makeConfigService(), // all empty
      );
      const settings = await resolver.resolveOracleConnectionSettings();
      expect(settings).toBeNull();
    });
  });

  describe('resolveOracleConnectionSettings — DB error', () => {
    it('falls back to environment variables when DB throws', async () => {
      const brokenPrisma = {
        fusionCredential: {
          findFirst: jest.fn().mockRejectedValue(new Error('DB connection lost')),
        },
      } as unknown as PrismaService;

      const resolver = new FusionCredentialResolver(
        brokenPrisma,
        makeConfigService({
          ORACLE_SOAP_BASE_URL: 'https://fallback.example.com',
          ORACLE_USERNAME: 'fb_user',
          ORACLE_PASSWORD: 'fb_pass',
        }),
      );

      const settings = await resolver.resolveOracleConnectionSettings();
      expect(settings?.source).toBe('environment');
      expect(settings?.soapBaseUrl).toBe('https://fallback.example.com');
    });
  });
});
