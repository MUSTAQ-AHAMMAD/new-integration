import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { JobType, ScopeType } from '../../database/enums';
import {
  IsArray,
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
} from 'class-validator';

export class CreateSyncJobDto {
  @ApiProperty({ enum: JobType })
  @IsEnum(JobType)
  jobType!: JobType;

  @ApiProperty({ enum: ScopeType })
  @IsEnum(ScopeType)
  scopeType!: ScopeType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  orderIds?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  branchCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional({
    description:
      'IANA timezone name used to interpret startDate/endDate (e.g. "Asia/Dubai"). Defaults to UTC.',
    example: 'Asia/Dubai',
  })
  @IsOptional()
  @IsString()
  timezone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  createdBy?: string;
}
