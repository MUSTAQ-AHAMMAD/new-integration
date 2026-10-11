import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import {
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { UsersService } from './users.service';
import { Roles } from '../auth/roles.decorator';
import { RequireArea } from '../auth/require-area.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import type { JwtPayload } from '../auth/jwt.strategy';

const ROLE_VALUES = ['ADMIN', 'OPERATOR', 'VIEWER'];

class CreateUserDto {
  @ApiProperty()
  @IsEmail()
  email!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional({
    description:
      'Omit to have the server generate a temporary password the user must change on first login.',
  })
  @IsOptional()
  @IsString()
  @MinLength(10)
  password?: string;

  @ApiProperty({ enum: ROLE_VALUES })
  @IsIn(ROLE_VALUES)
  role!: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({
    type: [String],
    description:
      'Area keys this user may see. Omit or send null to inherit the role defaults.',
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  areaOverrides?: string[] | null;
}

class UpdateUserDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional({ enum: ROLE_VALUES })
  @IsOptional()
  @IsIn(ROLE_VALUES)
  role?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  areaOverrides?: string[] | null;
}

class ResetPasswordDto {
  @ApiPropertyOptional({
    description: 'Omit to have the server generate a temporary password.',
  })
  @IsOptional()
  @IsString()
  @MinLength(10)
  password?: string;
}

/**
 * User administration. Double-locked: `@Roles('ADMIN')` gates the capability
 * and `@RequireArea('admin.users')` gates visibility, so an admin whose areas
 * were narrowed to (say) credentials cannot reach this API either.
 */
@ApiTags('users')
@Controller('users')
@Roles('ADMIN')
@RequireArea('admin.users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('areas')
  @ApiOperation({ summary: 'Catalogue of dashboard areas that can be granted' })
  areas() {
    return this.users.areaCatalog();
  }

  @Get()
  @ApiOperation({ summary: 'List dashboard accounts' })
  list() {
    return this.users.list();
  }

  @Post()
  @ApiOperation({ summary: 'Create a dashboard account' })
  create(@Body() body: CreateUserDto, @CurrentUser() actor: JwtPayload) {
    return this.users.create(body, actor.email);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update role, status, name or area visibility' })
  update(
    @Param('id') id: string,
    @Body() body: UpdateUserDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    return this.users.update(id, body, actor.sub);
  }

  @Post(':id/reset-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reset a user password; returns the new password once',
  })
  resetPassword(
    @Param('id') id: string,
    @Body() body: ResetPasswordDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    return this.users.resetPassword(id, body.password, actor.sub);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a dashboard account' })
  remove(@Param('id') id: string, @CurrentUser() actor: JwtPayload) {
    return this.users.remove(id, actor.sub);
  }
}
