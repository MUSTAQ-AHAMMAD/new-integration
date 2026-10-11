import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtStrategy } from './jwt.strategy';
import { JwtAuthGuard } from './jwt-auth.guard';
import { RolesGuard } from './roles.guard';
import { AreasGuard } from './areas.guard';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

@Module({
  imports: [
    UsersModule,
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const secret = config.get<string>('JWT_SECRET');
        if (!secret && config.get<string>('NODE_ENV') === 'production') {
          throw new Error(
            'JWT_SECRET environment variable is required in production',
          );
        }
        return {
          secret: secret ?? 'changeme',
          signOptions: {
            expiresIn: (config.get<string>('JWT_EXPIRES_IN') ?? '8h') as
              | `${number}${'s' | 'm' | 'h' | 'd' | 'w'}`
              | number,
          },
        };
      },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy, JwtAuthGuard, RolesGuard, AreasGuard],
  exports: [JwtModule, JwtAuthGuard, RolesGuard, AreasGuard],
})
export class AuthModule {}
