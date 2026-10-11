import { ALL_AREA_KEYS, AREAS, isKnownArea, resolveAreas } from './areas';

describe('areas catalogue', () => {
  it('has unique keys', () => {
    expect(new Set(ALL_AREA_KEYS).size).toBe(ALL_AREA_KEYS.length);
  });

  it('gives every area at least one route so the dashboard can filter on it', () => {
    for (const area of AREAS) {
      expect(area.routes.length).toBeGreaterThan(0);
    }
  });

  it('does not map the same route to two areas', () => {
    const seen = new Map<string, string>();
    for (const area of AREAS) {
      for (const route of area.routes) {
        expect(seen.has(route)).toBe(false);
        seen.set(route, area.key);
      }
    }
  });
});

describe('resolveAreas', () => {
  it('gives admins every area when no override is set', () => {
    expect(resolveAreas('ADMIN', null)).toEqual(ALL_AREA_KEYS);
  });

  it('keeps user management away from operators', () => {
    expect(resolveAreas('OPERATOR', null)).not.toContain('admin.users');
    expect(resolveAreas('OPERATOR', null)).not.toContain('admin.credentials');
  });

  it('gives viewers a read-only slice', () => {
    const viewer = resolveAreas('VIEWER', null);
    expect(viewer).toContain('reconciliation');
    expect(viewer).not.toContain('sync-control');
    expect(viewer).not.toContain('admin.credentials');
  });

  it('narrows an operator to the override', () => {
    expect(resolveAreas('OPERATOR', ['reports', 'audit'])).toEqual([
      'reports',
      'audit',
    ]);
  });

  it('will not let an override widen past the role', () => {
    expect(resolveAreas('VIEWER', ['reports', 'admin.credentials'])).toEqual([
      'reports',
    ]);
  });

  it('applies an admin override verbatim so a scoped admin is possible', () => {
    expect(resolveAreas('ADMIN', ['admin.credentials'])).toEqual([
      'admin.credentials',
    ]);
  });

  it('treats an empty override as "inherit the role", not "see nothing"', () => {
    expect(resolveAreas('VIEWER', [])).toEqual(resolveAreas('VIEWER', null));
  });

  it('ignores unknown keys, falling back to the role if none remain', () => {
    expect(resolveAreas('OPERATOR', ['not-a-real-area'])).toEqual(
      resolveAreas('OPERATOR', null),
    );
  });

  it('treats an unrecognised role as a viewer rather than an admin', () => {
    expect(resolveAreas('SUPERUSER', null)).toEqual(
      resolveAreas('VIEWER', null),
    );
  });

  it('recognises catalogue keys and rejects others', () => {
    expect(isKnownArea('reconciliation')).toBe(true);
    expect(isKnownArea('reconcilliation')).toBe(false);
  });
});
