import { Credential } from './credential';
import {
  buildSoapHeaders,
  buildAuthorizationHeader,
  basicAuthHeader,
} from './soap-utils';

describe('Credential', () => {
  describe('Basic Auth constructor', () => {
    const cred = new Credential('user', 'pass');

    it('encodes username:password as base64', () => {
      expect(cred.toString()).toBe(Buffer.from('user:pass').toString('base64'));
    });

    it('returns "Basic {base64}" from toAuthHeader', () => {
      const expected = `Basic ${Buffer.from('user:pass').toString('base64')}`;
      expect(cred.toAuthHeader()).toBe(expected);
    });

    it('isBasic() returns true', () => {
      expect(cred.isBasic()).toBe(true);
    });

    it('isBearer() returns false', () => {
      expect(cred.isBearer()).toBe(false);
    });
  });

  describe('Bearer-Token constructor', () => {
    const cred = new Credential('my-secret-token');

    it('stores the token as-is', () => {
      expect(cred.toString()).toBe('my-secret-token');
    });

    it('returns "Bearer my-secret-token" from toAuthHeader', () => {
      expect(cred.toAuthHeader()).toBe('Bearer my-secret-token');
    });

    it('isBearer() returns true', () => {
      expect(cred.isBearer()).toBe(true);
    });

    it('isBasic() returns false', () => {
      expect(cred.isBasic()).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('handles empty username and password', () => {
      const cred = new Credential('', '');
      expect(cred.toString()).toBe(Buffer.from(':').toString('base64'));
      expect(cred.toAuthHeader()).toMatch(/^Basic /);
    });

    it('handles special characters in username/password', () => {
      const cred = new Credential('user@domain.com', 'p@$$w0rd!');
      const encoded = Buffer.from('user@domain.com:p@$$w0rd!').toString(
        'base64',
      );
      expect(cred.toString()).toBe(encoded);
    });

    it('handles empty bearer token', () => {
      const cred = new Credential('');
      expect(cred.toString()).toBe('');
      expect(cred.toAuthHeader()).toBe('Bearer ');
    });
  });
});

describe('soap-utils', () => {
  const cred = new Credential('testuser', 'testpass');
  const expectedAuth = `Basic ${Buffer.from('testuser:testpass').toString('base64')}`;

  describe('buildSoapHeaders', () => {
    it('returns Content-Type and Authorization headers', () => {
      const headers = buildSoapHeaders(cred);
      expect(headers['Content-Type']).toBe('text/xml;charset=UTF-8');
      expect(headers['Authorization']).toBe(expectedAuth);
    });

    it('works with bearer credentials', () => {
      const bearerCred = new Credential('token123');
      const headers = buildSoapHeaders(bearerCred);
      expect(headers['Authorization']).toBe('Bearer token123');
    });
  });

  describe('buildAuthorizationHeader', () => {
    it('returns just the Authorization header value', () => {
      expect(buildAuthorizationHeader(cred)).toBe(expectedAuth);
    });
  });

  describe('basicAuthHeader', () => {
    it('returns the Basic auth header for username/password', () => {
      expect(basicAuthHeader('user', 'pass')).toBe(
        `Basic ${Buffer.from('user:pass').toString('base64')}`,
      );
    });
  });
});
