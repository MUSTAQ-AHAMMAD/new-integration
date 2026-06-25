/**
 * Credential — TypeScript equivalent of the Java Credential.java helper.
 *
 * Encapsulates either a Basic-Auth pair (username + password) or a raw
 * bearer token.  The `toString()` / `toAuthHeader()` methods return the
 * encoded value suitable for use in an HTTP Authorization header.
 *
 * Usage:
 *   // Basic Auth
 *   const cred = new Credential('user', 'pass');
 *   cred.toAuthHeader(); // "Basic dXNlcjpwYXNz"
 *
 *   // Bearer Token
 *   const cred = new Credential('my-token');
 *   cred.toAuthHeader(); // "Bearer my-token"
 */

/** Identifies how the credential should be serialised. */
export type CredentialType = 'basic' | 'bearer';

export class Credential {
  private readonly encodedValue: string;
  private readonly type: CredentialType;

  /**
   * Creates a **Basic-Auth** credential.
   *
   * @param username - Plain-text username.
   * @param password - Plain-text password.
   */
  constructor(username: string, password: string);

  /**
   * Creates a **Bearer-Token** credential.
   *
   * @param token - Raw bearer token (not base64-encoded).
   */
  constructor(token: string);

  constructor(usernameOrToken: string, password?: string) {
    if (password !== undefined) {
      // Basic Auth — base64-encode "username:password"
      this.encodedValue = Buffer.from(
        `${usernameOrToken}:${password}`,
      ).toString('base64');
      this.type = 'basic';
    } else {
      // Bearer Token — store as-is
      this.encodedValue = usernameOrToken;
      this.type = 'bearer';
    }
  }

  /**
   * Returns the encoded credential value.
   * - For Basic Auth: the base64 string (without the "Basic " prefix).
   * - For Bearer: the raw token.
   */
  toString(): string {
    return this.encodedValue;
  }

  /**
   * Returns the full `Authorization` header value, ready to set on an
   * HTTP request.
   *
   * - Basic:  `"Basic dXNlcjpwYXNz"`
   * - Bearer: `"Bearer <token>"`
   */
  toAuthHeader(): string {
    if (this.type === 'basic') {
      return `Basic ${this.encodedValue}`;
    }
    return `Bearer ${this.encodedValue}`;
  }

  /** Returns `true` when this is a Basic-Auth credential. */
  isBasic(): boolean {
    return this.type === 'basic';
  }

  /** Returns `true` when this is a Bearer-Token credential. */
  isBearer(): boolean {
    return this.type === 'bearer';
  }
}
