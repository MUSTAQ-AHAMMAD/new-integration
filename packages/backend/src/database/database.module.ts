import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { buildOracleDataSourceOptions } from './data-source';

/**
 * Wires the TypeORM Oracle connection into Nest — the sole application database.
 * Feature modules import `TypeOrmModule.forFeature([...entities])` to inject
 * repositories; generic services (admin, reports) use the DataSource directly.
 */
@Global()
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      useFactory: () => ({
        ...buildOracleDataSourceOptions(),
        autoLoadEntities: true,
      }),
    }),
  ],
})
export class DatabaseModule {}
