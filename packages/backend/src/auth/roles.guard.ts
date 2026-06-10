import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from './public.decorator';
import { ROLES_KEY, UserRole } from './roles.decorator';
import type { JwtPayload } from './jwt.strategy';

interface RequestWithUser extends Request {
  user?: JwtPayload;
}

/**
 * Enforces role-based access control.
 * Works in tandem with JwtAuthGuard: the JWT user is already attached to
 * request.user by the time this guard runs.
 *
 * A route with no \@Roles() annotation allows any authenticated user through.
 * A route marked \@Public() also skips this guard entirely.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // Skip for public routes
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const requiredRoles = this.reflector.getAllAndOverride<UserRole[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    // No role constraint → any authenticated user may proceed
    if (!requiredRoles || requiredRoles.length === 0) return true;

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const user = request.user;

    if (!user) return false;

    if (!requiredRoles.includes(user.role as UserRole)) {
      throw new ForbiddenException(
        `Requires one of roles: ${requiredRoles.join(', ')}`,
      );
    }

    return true;
  }
}
