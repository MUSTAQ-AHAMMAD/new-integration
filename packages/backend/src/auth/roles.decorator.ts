import { SetMetadata } from '@nestjs/common';

export type UserRole = 'ADMIN' | 'OPERATOR' | 'VIEWER';

export const ROLES_KEY = 'roles';

/**
 * Restrict a route to specific roles.
 * Requires the global RolesGuard to be active.
 *
 * @example
 * \@Roles('ADMIN')
 * \@Delete(':id')
 * remove(@Param('id') id: string) { ... }
 */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
