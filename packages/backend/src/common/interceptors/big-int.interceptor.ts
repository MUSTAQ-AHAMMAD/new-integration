/**
 * BigIntInterceptor - Global interceptor to safely serialize BigInt values
 * 
 * This interceptor ensures all API responses can be serialized to JSON
 * even when they contain BigInt fields from Prisma.
 * 
 * The BigInt.prototype.toJSON in main.ts handles most cases, but this
 * interceptor provides an additional safety layer for complex nested objects.
 */
import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

@Injectable()
export class BigIntInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    return next.handle().pipe(
      map(data => this.serializeBigInt(data))
    );
  }

  /**
   * Recursively converts BigInt values to Numbers in nested structures.
   * Throws if BigInt exceeds Number.MAX_SAFE_INTEGER to prevent data loss.
   */
  private serializeBigInt(data: any): any {
    if (data === null || data === undefined) {
      return data;
    }
    
    if (typeof data === 'bigint') {
      // Safety check: throw if BigInt would lose precision when converted
      if (data > BigInt(Number.MAX_SAFE_INTEGER) || data < BigInt(-Number.MAX_SAFE_INTEGER)) {
        throw new RangeError(
          `BigInt value ${data.toString()} cannot be safely serialized as a JSON number (exceeds MAX_SAFE_INTEGER)`
        );
      }
      return Number(data);
    }
    
    if (Array.isArray(data)) {
      return data.map(item => this.serializeBigInt(item));
    }
    
    if (typeof data === 'object') {
      const result: Record<string, any> = {};
      for (const [key, value] of Object.entries(data)) {
        result[key] = this.serializeBigInt(value);
      }
      return result;
    }
    
    return data;
  }
}
