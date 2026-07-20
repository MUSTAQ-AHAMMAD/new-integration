import { EntityMetadata } from 'typeorm';
import { ColumnMetadata } from 'typeorm/metadata/ColumnMetadata';
import {
  booleanTransformer,
  decimalTransformer,
  bigintTransformer,
  jsonTransformer,
} from './transformers';

/**
 * Field-type metadata derived from TypeORM entity metadata — the replacement for
 * the former `Prisma.dmmf` runtime reflection used by the generic admin CRUD/CSV
 * engine and the dynamic report builder. Oracle stores booleans as NUMBER(1),
 * JSON as CLOB, etc., so the semantic category is recovered from the column's
 * value transformer plus its DB type.
 */
export type FieldCategory =
  | 'Int'
  | 'BigInt'
  | 'Decimal'
  | 'Boolean'
  | 'DateTime'
  | 'String'
  | 'Json';

export interface ScalarField {
  name: string;
  category: FieldCategory;
}

function transformerOf(col: ColumnMetadata): unknown {
  const t = col.transformer;
  return Array.isArray(t) ? t[0] : t;
}

/** Maps one TypeORM column to its semantic category. */
export function categoryOf(col: ColumnMetadata): FieldCategory {
  const t = transformerOf(col);
  if (t === booleanTransformer) return 'Boolean';
  if (t === decimalTransformer) return 'Decimal';
  if (t === bigintTransformer) return 'BigInt';
  if (t === jsonTransformer) return 'Json';
  if (col.isCreateDate || col.isUpdateDate) return 'DateTime';
  const type = String(col.type);
  if (type === 'timestamp' || type === 'date' || type === 'datetime')
    return 'DateTime';
  if (type === 'number') return 'Int';
  return 'String'; // varchar2, clob, etc.
}

/**
 * Returns the scalar (non-relation) fields of an entity as {name, category}.
 * TypeORM's `columns` already excludes relation objects (a FK is a plain column,
 * which is fine to expose); embedded/relation-owned columns are skipped.
 */
export function scalarFields(meta: EntityMetadata): ScalarField[] {
  return meta.columns
    .filter((c) => !c.relationMetadata) // skip FK columns owned by a relation
    .map((c) => ({ name: c.propertyName, category: categoryOf(c) }));
}

/** property-name → category map for the entity's scalar columns. */
export function fieldCategoryMap(meta: EntityMetadata): Map<string, FieldCategory> {
  return new Map(scalarFields(meta).map((f) => [f.name, f.category]));
}

/**
 * Finds the property name of a ManyToOne/OneToOne relation whose target entity
 * carries a `region` column — used to filter child tables (order lines/payments)
 * by region through their parent. Returns null when none exists.
 */
export function regionRelationProperty(meta: EntityMetadata): string | null {
  for (const rel of meta.relations) {
    if (!rel.isManyToOne && !rel.isOneToOne) continue;
    const target = rel.inverseEntityMetadata;
    if (target.columns.some((c) => c.propertyName === 'region')) {
      return rel.propertyName;
    }
  }
  return null;
}
