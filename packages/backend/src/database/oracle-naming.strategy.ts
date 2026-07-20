import { DefaultNamingStrategy, NamingStrategyInterface, Table } from 'typeorm';
import { createHash } from 'crypto';

/**
 * Oracle 12.1 caps identifiers at 30 bytes (128 only from 12.2+). TypeORM's
 * default index/constraint/FK names routinely exceed that, so this strategy
 * truncates every generated identifier to ≤30 chars, keeping a readable prefix
 * and appending a deterministic hash to avoid collisions.
 */
function cap(prefix: string, raw: string): string {
  const name = `${prefix}_${raw}`;
  if (name.length <= 30) return name.toUpperCase();
  const hash = createHash('md5').update(name).digest('hex');
  // prefix (≤3) + '_' + hash → keep within 30
  return `${prefix}_${hash}`.slice(0, 30).toUpperCase();
}

function tableName(tableOrName: Table | string): string {
  return typeof tableOrName === 'string' ? tableOrName : tableOrName.name;
}

export class OracleNamingStrategy
  extends DefaultNamingStrategy
  implements NamingStrategyInterface
{
  primaryKeyName(tableOrName: Table | string, columnNames: string[]): string {
    return cap('PK', `${tableName(tableOrName)}_${columnNames.join('_')}`);
  }

  uniqueConstraintName(
    tableOrName: Table | string,
    columnNames: string[],
  ): string {
    return cap('UQ', `${tableName(tableOrName)}_${columnNames.join('_')}`);
  }

  relationConstraintName(
    tableOrName: Table | string,
    columnNames: string[],
    where?: string,
  ): string {
    return cap(
      'REL',
      `${tableName(tableOrName)}_${columnNames.join('_')}${where ? '_' + where : ''}`,
    );
  }

  defaultConstraintName(
    tableOrName: Table | string,
    columnName: string,
  ): string {
    return cap('DF', `${tableName(tableOrName)}_${columnName}`);
  }

  foreignKeyName(
    tableOrName: Table | string,
    columnNames: string[],
  ): string {
    return cap('FK', `${tableName(tableOrName)}_${columnNames.join('_')}`);
  }

  indexName(
    tableOrName: Table | string,
    columns: string[],
    where?: string,
  ): string {
    return cap(
      'IDX',
      `${tableName(tableOrName)}_${columns.join('_')}${where ? '_' + where : ''}`,
    );
  }

  checkConstraintName(
    tableOrName: Table | string,
    expression: string,
  ): string {
    return cap('CHK', `${tableName(tableOrName)}_${expression}`);
  }

  exclusionConstraintName(
    tableOrName: Table | string,
    expression: string,
  ): string {
    return cap('XCL', `${tableName(tableOrName)}_${expression}`);
  }
}
