import { Field, InputType, Int, Mutation, ObjectType, Query, Resolver, registerEnumType, Args } from '@nestjs/graphql';
import { JobStatus, JobType, ScopeType } from '@prisma/client';
import { IsArray, IsDateString, IsEnum, IsOptional, IsString } from 'class-validator';
import { SyncService } from './sync.service';

registerEnumType(JobType, { name: 'SyncJobTypeEnum' });
registerEnumType(ScopeType, { name: 'SyncScopeTypeEnum' });
registerEnumType(JobStatus, { name: 'SyncJobStatusEnum' });

@ObjectType()
export class SyncJobType {
  @Field()
  id!: string;

  @Field(() => JobType)
  jobType!: JobType;

  @Field(() => ScopeType)
  scopeType!: ScopeType;

  @Field(() => JobStatus)
  status!: JobStatus;

  @Field(() => Int)
  totalRecords!: number;

  @Field(() => Int)
  processedRecords!: number;

  @Field(() => Int)
  successCount!: number;

  @Field(() => Int)
  failedCount!: number;

  @Field(() => Int)
  skippedCount!: number;

  @Field()
  createdBy!: string;

  @Field()
  createdAt!: Date;
}

@InputType()
class CreateSyncJobInput {
  @Field(() => JobType)
  @IsEnum(JobType)
  jobType!: JobType;

  @Field(() => ScopeType)
  @IsEnum(ScopeType)
  scopeType!: ScopeType;

  @Field(() => [String], { nullable: true })
  @IsOptional()
  @IsArray()
  orderIds?: string[];

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  branchCode?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  createdBy?: string;
}

@Resolver(() => SyncJobType)
export class SyncResolver {
  constructor(private readonly syncService: SyncService) {}

  @Query(() => [SyncJobType], { name: 'syncJobs' })
  async syncJobs() {
    const jobs = await this.syncService.listSyncJobs(undefined, 50);
    return jobs.map((job) => this.mapJob(job));
  }

  @Query(() => SyncJobType, { name: 'syncJob' })
  async syncJob(@Args('id') id: string) {
    const job = await this.syncService.getSyncJob(id);
    return this.mapJob(job);
  }

  @Mutation(() => SyncJobType, { name: 'createSyncJob' })
  async createSyncJob(@Args('input') input: CreateSyncJobInput) {
    const job = await this.syncService.createSyncJob(input);
    return this.mapJob(job);
  }

  private mapJob(job: {
    id: string;
    jobType: JobType;
    scopeType: ScopeType;
    status: JobStatus;
    totalRecords: number;
    processedRecords: number;
    successCount: number;
    failedCount: number;
    skippedCount: number;
    createdBy: string;
    createdAt: Date;
  }): SyncJobType {
    return {
      id: job.id,
      jobType: job.jobType,
      scopeType: job.scopeType,
      status: job.status,
      totalRecords: job.totalRecords,
      processedRecords: job.processedRecords,
      successCount: job.successCount,
      failedCount: job.failedCount,
      skippedCount: job.skippedCount,
      createdBy: job.createdBy,
      createdAt: job.createdAt,
    };
  }
}
