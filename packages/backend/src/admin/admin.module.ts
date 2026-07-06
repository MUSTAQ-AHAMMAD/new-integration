import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MulterModule } from '@nestjs/platform-express';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { OracleNativeService } from './oracle-native.service';
import { SyncControlController } from './sync-control.controller';
import { AdminDiagnosticsController } from './admin-diagnostics.controller';
import { RegisterAccountsController } from './register-accounts.controller';
import { RegisterAccountsService } from './register-accounts.service';
import { PrismaModule } from '../prisma/prisma.module';
import { SyncModule } from '../sync/sync.module';
import { OracleModule } from '../clients/oracle/oracle.module';

@Module({
  imports: [
    PrismaModule,
    ConfigModule,
    MulterModule.register({ limits: { fileSize: 50 * 1024 * 1024 } }),
    forwardRef(() => SyncModule),
    OracleModule,
  ],
  controllers: [
    AdminController,
    SyncControlController,
    AdminDiagnosticsController,
    RegisterAccountsController,
  ],
  providers: [AdminService, OracleNativeService, RegisterAccountsService],
})
export class AdminModule {}
