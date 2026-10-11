import { randomBytes, scrypt, timingSafeEqual } from 'crypto';
import { promisify } from 'util';

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

// scrypt rather than bcrypt/argon2: both of those are native addons that would
// have to compile in the Docker image, and scrypt is already in Node's stdlib
// with the same memory-hard properties. N=2^15 keeps a hash around ~100ms here.
const N = 32768;
const R = 8;
const P = 1;
const KEYLEN = 64;
// scrypt's default maxmem (32 MiB) is below what N=2^15,r=8 needs (~128 * N * r).
const MAXMEM = 192 * 1024 * 1024;

const PREFIX = 'scrypt';

/** Produces `scrypt$N$r$p$saltHex$hashHex` — self-describing so parameters can change later. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt, KEYLEN, {
    N,
    r: R,
    p: P,
    maxmem: MAXMEM,
  });
  return [PREFIX, N, R, P, salt.toString('hex'), derived.toString('hex')].join(
    '$',
  );
}

/**
 * Constant-time verification. Returns false (never throws) for a malformed or
 * unrecognised digest, so a corrupted row rejects the login instead of 500-ing
 * the whole auth endpoint.
 */
export async function verifyPassword(
  password: string,
  stored: string | null | undefined,
): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== PREFIX) return false;

  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) {
    return false;
  }

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4], 'hex');
    expected = Buffer.from(parts[5], 'hex');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  try {
    const derived = await scryptAsync(password, salt, expected.length, {
      N: n,
      r,
      p,
      maxmem: MAXMEM,
    });
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/** Minimum bar for a dashboard password; kept in one place so API and seed agree. */
export function validatePasswordStrength(password: string): string | null {
  if (password.length < 10) {
    return 'Password must be at least 10 characters long';
  }
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    return 'Password must contain at least one letter and one number';
  }
  return null;
}

/** Generates a readable temporary password for admin-issued resets. */
export function generateTemporaryPassword(): string {
  // Base64url of 12 random bytes is 16 chars, mixes case and digits, and has
  // no ambiguous punctuation to garble when copied into an email.
  return `${randomBytes(12).toString('base64url')}1a`;
}
