/**
 * SOAP authentication helpers — TypeScript equivalent of the Java SOAPUtils.java.
 *
 * Provides utilities for attaching credentials to outgoing SOAP/HTTP requests,
 * mirroring the `setCredentials` and header-building helpers used alongside
 * JAX-WS stubs in the original Java integration platform.
 */

import { Credential } from './credential';

/**
 * Builds a set of HTTP headers suitable for an authenticated SOAP request.
 *
 * The returned object can be spread directly into an `axios` request's
 * `headers` field.
 *
 * @param credential - The `Credential` to use for authentication.
 * @returns Record of HTTP headers including `Authorization` and `Content-Type`.
 */
export function buildSoapHeaders(
  credential: Credential,
): Record<string, string> {
  return {
    'Content-Type': 'text/xml;charset=UTF-8',
    Authorization: credential.toAuthHeader(),
  };
}

/**
 * Returns only the `Authorization` header value for the given credential.
 *
 * Equivalent to `setCredentials(port, credential)` in the Java code, which
 * attaches the header to a JAX-WS port's request context.
 *
 * @param credential - The `Credential` to serialise.
 * @returns The `Authorization` header string (e.g. `"Basic dXNlcjpwYXNz"`).
 */
export function buildAuthorizationHeader(credential: Credential): string {
  return credential.toAuthHeader();
}

/**
 * Creates a `Credential` for HTTP Basic Authentication and returns the
 * corresponding `Authorization` header value.
 *
 * Convenience wrapper matching the Java
 * `new Credential(username, password).toString()` pattern.
 *
 * @param username - Plain-text username.
 * @param password - Plain-text password.
 * @returns `"Basic {base64(username:password)}"` header value.
 */
export function basicAuthHeader(username: string, password: string): string {
  return new Credential(username, password).toAuthHeader();
}
