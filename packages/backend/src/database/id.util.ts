import { randomUUID } from 'crypto';

/**
 * Generates a primary-key string for entities that previously used Prisma's
 * `@default(cuid())` / `@default(uuid())`. Oracle has no equivalent default, so
 * ids are generated in-app via a `@BeforeInsert` hook on each entity. Uses the
 * Node built-in crypto.randomUUID() (no external dependency); existing ids are
 * never parsed for structure.
 */
export function generateId(): string {
  return randomUUID();
}
