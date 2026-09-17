import { SetMetadata } from '@nestjs/common';

export const AREA_KEY = 'required-area';

/**
 * Restrict a route to accounts that can see a dashboard area.
 * Requires the global AreasGuard to be active.
 *
 * Roles answer "what may this person do"; areas answer "what may they see".
 * A route serving one screen should use this, so hiding the nav entry and
 * blocking the API stay in sync from a single grant.
 *
 * @example
 * \@RequireArea('reconciliation')
 * \@Get('summary')
 * summary() { ... }
 */
export const RequireArea = (...areas: string[]) => SetMetadata(AREA_KEY, areas);
