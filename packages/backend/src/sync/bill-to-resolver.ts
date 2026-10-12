/**
 * Pure bill-to (FusionSalesMetadata) matching, shared by the posting path
 * (OdooTransformationService) and the Bill-to Mapping admin screen so the
 * screen can never disagree with what a run will actually resolve.
 */

/**
 * FusionSalesMetadata.subinventory value marking a region's default bill-to,
 * used by any store in that region (and customer type) without its own row.
 */
export const REGION_DEFAULT_SUBINVENTORY = '*';

/** How a bill-to row was found for a store. */
export type BillToMatchVia =
  /** The store's own row: subinventory == branch name (Java key). */
  | 'SUBINVENTORY'
  /** NORMAL only: the customer's billToName == branch name. */
  | 'BILL_TO_NAME'
  /** The region's '*' default row. */
  | 'REGION_DEFAULT'
  /** Non-NORMAL only: another branch's row for the same platform customer. */
  | 'SHARED_PROVIDER';

export interface BillToCandidate {
  subinventory: string | null;
  billToName: string | null;
  customerType: string | null;
}

/** Upper-cases and strips everything but A-Z/0-9 ("Al Jubail-2" → "ALJUBAIL2"). */
export function normalizeStoreName(s: string | null | undefined): string {
  return (s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function isRegionDefault(r: { subinventory: string | null }): boolean {
  return (r.subinventory ?? '').trim() === REGION_DEFAULT_SUBINVENTORY;
}

/**
 * Picks the bill-to row for a branch from one region's rows.
 *
 * - Primary: normalised subinventory == branchName within the customer type.
 * - NORMAL: normalised billToName == branchName, else the region default.
 * - Non-NORMAL: the region default, else any row of that type — the platform
 *   customer is shared across branches; only the site is per-branch.
 * Returns null when nothing matches.
 */
export function matchBillTo<T extends BillToCandidate>(
  regionRows: T[],
  customerType: string,
  branchName: string,
): { row: T; via: BillToMatchVia } | null {
  const typeUpper = (customerType || 'NORMAL').trim().toUpperCase();
  const target = normalizeStoreName(branchName);
  const ofType = regionRows.filter(
    (r) => (r.customerType ?? '').trim().toUpperCase() === typeUpper,
  );
  const regionDefault = ofType.find(isRegionDefault) ?? null;
  const perStore = ofType.filter((r) => !isRegionDefault(r));

  const own = target
    ? perStore.find((r) => normalizeStoreName(r.subinventory) === target)
    : undefined;
  if (own) return { row: own, via: 'SUBINVENTORY' };

  if (typeUpper === 'NORMAL') {
    const byName = target
      ? perStore.find((r) => normalizeStoreName(r.billToName) === target)
      : undefined;
    if (byName) return { row: byName, via: 'BILL_TO_NAME' };
    return regionDefault ? { row: regionDefault, via: 'REGION_DEFAULT' } : null;
  }

  if (regionDefault) return { row: regionDefault, via: 'REGION_DEFAULT' };
  return perStore[0] ? { row: perStore[0], via: 'SHARED_PROVIDER' } : null;
}
