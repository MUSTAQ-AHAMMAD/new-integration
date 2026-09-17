import {
  generateTemporaryPassword,
  hashPassword,
  validatePasswordStrength,
  verifyPassword,
} from './password.util';

describe('password hashing', () => {
  // scrypt at N=2^15 is deliberately slow; give these room.
  jest.setTimeout(30000);

  it('verifies a password against its own hash', async () => {
    const hash = await hashPassword('correct-horse-1');
    await expect(verifyPassword('correct-horse-1', hash)).resolves.toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('correct-horse-1');
    await expect(verifyPassword('correct-horse-2', hash)).resolves.toBe(false);
  });

  it('salts each hash so identical passwords do not collide', async () => {
    const a = await hashPassword('same-password-1');
    const b = await hashPassword('same-password-1');
    expect(a).not.toBe(b);
    await expect(verifyPassword('same-password-1', b)).resolves.toBe(true);
  });

  it('returns false rather than throwing for a malformed digest', async () => {
    await expect(verifyPassword('x', 'not-a-digest')).resolves.toBe(false);
    await expect(verifyPassword('x', 'scrypt$a$b$c$d$e')).resolves.toBe(false);
    await expect(verifyPassword('x', '')).resolves.toBe(false);
    await expect(verifyPassword('x', null)).resolves.toBe(false);
  });

  it('produces a self-describing digest', async () => {
    const hash = await hashPassword('correct-horse-1');
    expect(hash.split('$')).toHaveLength(6);
    expect(hash.startsWith('scrypt$')).toBe(true);
  });
});

describe('validatePasswordStrength', () => {
  it('accepts a password with letters, digits and enough length', () => {
    expect(validatePasswordStrength('integration1')).toBeNull();
  });

  it('rejects short passwords', () => {
    expect(validatePasswordStrength('short1')).toMatch(/10 characters/);
  });

  it('rejects letter-only and digit-only passwords', () => {
    expect(validatePasswordStrength('allletters')).toMatch(
      /letter and one number/,
    );
    expect(validatePasswordStrength('1234567890')).toMatch(
      /letter and one number/,
    );
  });
});

describe('generateTemporaryPassword', () => {
  it('always passes the strength check it will be validated against', () => {
    for (let i = 0; i < 20; i++) {
      expect(validatePasswordStrength(generateTemporaryPassword())).toBeNull();
    }
  });

  it('does not repeat', () => {
    const generated = new Set(
      Array.from({ length: 20 }, () => generateTemporaryPassword()),
    );
    expect(generated.size).toBe(20);
  });
});
