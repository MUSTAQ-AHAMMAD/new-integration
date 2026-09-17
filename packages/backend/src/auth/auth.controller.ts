import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsString, MinLength } from 'class-validator';
import { AuthService } from './auth.service';
import { Public } from './public.decorator';
import { CurrentUser } from './current-user.decorator';
import type { JwtPayload } from './jwt.strategy';

class LoginDto {
  @IsString()
  email!: string;

  @IsString()
  password!: string;
}

class ChangePasswordDto {
  @IsString()
  currentPassword!: string;

  @IsString()
  @MinLength(10)
  newPassword!: string;
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  @Public()
  @HttpCode(HttpStatus.OK)
  // Strict brute-force protection: max 10 attempts per minute per IP.
  // This overrides the global medium throttle (300/min) for this endpoint only.
  @Throttle({ medium: { limit: 10, ttl: 60000 } })
  @ApiOperation({ summary: 'Sign in — returns a JWT access token and profile' })
  login(@Body() body: LoginDto) {
    return this.authService.login(body.email, body.password);
  }

  @Get('me')
  @ApiOperation({
    summary: 'Current account, role and the dashboard areas it may see',
  })
  me(@CurrentUser() user: JwtPayload) {
    return this.authService.me(user);
  }

  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  @Throttle({ medium: { limit: 10, ttl: 60000 } })
  @ApiOperation({ summary: 'Change your own password' })
  changePassword(
    @CurrentUser() user: JwtPayload,
    @Body() body: ChangePasswordDto,
  ) {
    return this.authService.changePassword(
      user,
      body.currentPassword,
      body.newPassword,
    );
  }
}
