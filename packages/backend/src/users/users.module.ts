import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppUser } from '../database/entities/app-user.entity';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [TypeOrmModule.forFeature([AppUser])],
  controllers: [UsersController],
  providers: [UsersService],
  // AuthModule consumes UsersService for login, /auth/me and password changes.
  exports: [UsersService],
})
export class UsersModule {}
