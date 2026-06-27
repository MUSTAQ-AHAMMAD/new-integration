import { ApiProperty } from '@nestjs/swagger';

/**
 * OrderResponseDto - DTO for order responses with proper date serialization
 * 
 * Fixes "[object Ob]" issue by converting Date objects to ISO strings
 * Adapted to work with OrderSyncQueue structure
 */
export class OrderResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  orderNumber: string;

  @ApiProperty()
  branchCode: string;

  @ApiProperty()
  branchName: string;

  @ApiProperty({ type: String, format: 'date-time' })
  orderDate: string; // Use string, not Date

  @ApiProperty({ type: String, format: 'date-time' })
  orderDateUtc: string;

  @ApiProperty({ type: Number })
  totalAmount: number;

  @ApiProperty()
  currency: string;

  @ApiProperty()
  syncStatus: string;

  @ApiProperty()
  customerName: string | null;

  @ApiProperty()
  customerEmail: string | null;

  @ApiProperty()
  isPaid: boolean;

  @ApiProperty()
  isCancelled: boolean;

  @ApiProperty()
  isRefund: boolean;

  @ApiProperty()
  syncAttempts: number;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  lastSyncAt: string | null;

  @ApiProperty({ nullable: true })
  errorMessage: string | null;

  constructor(order: any) {
    this.id = order.id;
    this.orderNumber = order.odooOrderNumber || order.orderNumber;
    this.branchCode = order.branchCode;
    this.branchName = order.branchName || 'Unknown';
    
    // FIX: Format dates properly to ISO strings
    this.orderDate = order.orderDate 
      ? new Date(order.orderDate).toISOString() 
      : new Date().toISOString();
    this.orderDateUtc = order.orderDateUtc
      ? new Date(order.orderDateUtc).toISOString()
      : this.orderDate;
    
    this.totalAmount = Number(order.totalAmount || 0);
    this.currency = order.currency || 'AED';
    this.syncStatus = order.status || 'PENDING';
    this.customerName = order.customerName || null;
    this.customerEmail = order.customerEmail || null;
    this.isPaid = order.isPaid ?? false;
    this.isCancelled = order.isCancelled ?? false;
    this.isRefund = order.isRefund ?? false;
    this.syncAttempts = order.syncAttempts || 0;
    this.lastSyncAt = order.lastSyncAt 
      ? new Date(order.lastSyncAt).toISOString() 
      : null;
    this.errorMessage = order.errorMessage || null;
  }
}

/**
 * OrderListResponseDto - Response wrapper for paginated order lists
 */
export class OrderListResponseDto {
  @ApiProperty({ type: [OrderResponseDto] })
  data: OrderResponseDto[];

  @ApiProperty()
  total: number;

  @ApiProperty()
  skip: number;

  @ApiProperty()
  take: number;

  constructor(orders: any[], total: number, skip: number, take: number) {
    this.data = orders.map(order => new OrderResponseDto(order));
    this.total = total;
    this.skip = skip;
    this.take = take;
  }
}
