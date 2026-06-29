import { BigIntInterceptor } from './big-int.interceptor';
import { of } from 'rxjs';
import { ExecutionContext, CallHandler } from '@nestjs/common';

describe('BigIntInterceptor', () => {
  let interceptor: BigIntInterceptor;
  let mockExecutionContext: ExecutionContext;
  let mockCallHandler: CallHandler;

  beforeEach(() => {
    interceptor = new BigIntInterceptor();
    mockExecutionContext = {} as ExecutionContext;
  });

  describe('serializeBigInt', () => {
    it('should convert BigInt to number', (done) => {
      const testData = { value: 12345n };
      mockCallHandler = {
        handle: () => of(testData),
      };

      interceptor.intercept(mockExecutionContext, mockCallHandler).subscribe({
        next: (result) => {
          expect(result.value).toBe(12345);
          expect(typeof result.value).toBe('number');
          done();
        },
      });
    });

    it('should preserve Date objects', (done) => {
      const testDate = new Date('2024-01-15T10:00:00Z');
      const testData = { createdAt: testDate };
      mockCallHandler = {
        handle: () => of(testData),
      };

      interceptor.intercept(mockExecutionContext, mockCallHandler).subscribe({
        next: (result) => {
          expect(result.createdAt).toBeInstanceOf(Date);
          expect(result.createdAt.toISOString()).toBe(testDate.toISOString());
          done();
        },
      });
    });

    it('should preserve Date objects in nested structures', (done) => {
      const testDate1 = new Date('2024-01-15T10:00:00Z');
      const testDate2 = new Date('2024-01-16T10:00:00Z');
      const testData = {
        job: {
          id: '123',
          createdAt: testDate1,
          updatedAt: testDate2,
        },
      };
      mockCallHandler = {
        handle: () => of(testData),
      };

      interceptor.intercept(mockExecutionContext, mockCallHandler).subscribe({
        next: (result) => {
          expect(result.job.createdAt).toBeInstanceOf(Date);
          expect(result.job.updatedAt).toBeInstanceOf(Date);
          expect(result.job.createdAt.toISOString()).toBe(testDate1.toISOString());
          expect(result.job.updatedAt.toISOString()).toBe(testDate2.toISOString());
          done();
        },
      });
    });

    it('should handle arrays with Date objects', (done) => {
      const testDate = new Date('2024-01-15T10:00:00Z');
      const testData = {
        jobs: [
          { id: '1', createdAt: testDate },
          { id: '2', createdAt: testDate },
        ],
      };
      mockCallHandler = {
        handle: () => of(testData),
      };

      interceptor.intercept(mockExecutionContext, mockCallHandler).subscribe({
        next: (result) => {
          expect(result.jobs[0].createdAt).toBeInstanceOf(Date);
          expect(result.jobs[1].createdAt).toBeInstanceOf(Date);
          done();
        },
      });
    });

    it('should handle mixed BigInt and Date objects', (done) => {
      const testDate = new Date('2024-01-15T10:00:00Z');
      const testData = {
        accountId: 123456789n,
        createdAt: testDate,
        updatedAt: testDate,
      };
      mockCallHandler = {
        handle: () => of(testData),
      };

      interceptor.intercept(mockExecutionContext, mockCallHandler).subscribe({
        next: (result) => {
          expect(typeof result.accountId).toBe('number');
          expect(result.accountId).toBe(123456789);
          expect(result.createdAt).toBeInstanceOf(Date);
          expect(result.updatedAt).toBeInstanceOf(Date);
          done();
        },
      });
    });

    it('should throw error for BigInt exceeding MAX_SAFE_INTEGER', (done) => {
      const testData = { value: BigInt(Number.MAX_SAFE_INTEGER) + 1n };
      mockCallHandler = {
        handle: () => of(testData),
      };

      interceptor.intercept(mockExecutionContext, mockCallHandler).subscribe({
        error: (error) => {
          expect(error).toBeInstanceOf(RangeError);
          expect(error.message).toContain('MAX_SAFE_INTEGER');
          done();
        },
      });
    });

    it('should handle null and undefined values', (done) => {
      const testData = {
        nullValue: null,
        undefinedValue: undefined,
        date: new Date('2024-01-15T10:00:00Z'),
      };
      mockCallHandler = {
        handle: () => of(testData),
      };

      interceptor.intercept(mockExecutionContext, mockCallHandler).subscribe({
        next: (result) => {
          expect(result.nullValue).toBeNull();
          expect(result.undefinedValue).toBeUndefined();
          expect(result.date).toBeInstanceOf(Date);
          done();
        },
      });
    });
  });
});
