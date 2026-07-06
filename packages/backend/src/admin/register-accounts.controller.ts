import { Body, Controller, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../auth/roles.decorator';
import {
  AccountAssignment,
  RegisterAccountsService,
} from './register-accounts.service';

/**
 * Admin utility: refresh VendHqRegister bank/cash account IDs with the current
 * Oracle Fusion account IDs (the remittance account passed on every receipt).
 * Preview computes proposed matches; apply writes the confirmed assignments.
 */
@ApiTags('admin')
@Controller('admin/register-accounts')
@Roles('ADMIN')
export class RegisterAccountsController {
  constructor(private readonly service: RegisterAccountsService) {}

  @Post('preview')
  @ApiOperation({
    summary:
      'Fetch Oracle bank/cash accounts and propose matches for each register',
  })
  preview(@Body() body: { region?: string }) {
    return this.service.preview(body?.region);
  }

  @Post('apply')
  @ApiOperation({
    summary: 'Write confirmed bank/cash account IDs onto VendHqRegister rows',
  })
  apply(@Body() body: { assignments: AccountAssignment[] }) {
    return this.service.apply(body?.assignments ?? []);
  }
}
