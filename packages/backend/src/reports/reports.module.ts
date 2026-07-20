import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

// ReportsService uses the global TypeORM DataSource (getRepository / getMetadata),
// so no PrismaModule and no forFeature registration is required.
@Module({
  controllers: [ReportsController],
  providers: [ReportsService],
})
export class ReportsModule {}
