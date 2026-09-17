import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from './public.decorator';
import { AREA_KEY } from './require-area.decorator';
import { resolveAreas } from './areas';
import type { JwtPayload } from './jwt.strategy';

interface RequestWithUser extends Request {
  user?: JwtPayload;
}

/**
 * Enforces per-area visibility. Runs after JwtAuthGuard, so request.user is
 * already populated.
 *
 * Routes with no \@RequireArea() are unaffected — this guard only narrows what
 * has been explicitly labelled, which keeps every existing endpoint working.
 */
@Injectable()
export class AreasGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const required = this.reflector.getAllAndOverride<string[]>(AREA_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const user = context.switchToHttp().getRequest<RequestWithUser>().user;
    if (!user) return false;

    // Tokens minted before areas existed carry no `areas` claim; fall back to
    // the role defaults so a live session is narrowed, not locked out.
    const granted = user.areas ?? resolveAreas(user.role, null);

    if (!required.some((area) => granted.includes(area))) {
      throw new ForbiddenException(
        `Your account does not have access to: ${required.join(', ')}`,
      );
    }
    return true;
  }
}
