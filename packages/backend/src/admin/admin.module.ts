import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MulterModule } from '@nestjs/platform-express';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { OracleNativeService } from './oracle-native.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [
    PrismaModule,
    ConfigModule,
    MulterModule.register({ limits: { fileSize: 50 * 1024 * 1024 } }),
  ],
  controllers: [AdminController],
  providers: [AdminService, OracleNativeService],
})
export class AdminModule {}
