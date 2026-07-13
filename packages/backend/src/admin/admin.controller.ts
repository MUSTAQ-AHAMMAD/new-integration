import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { Response } from 'express';
import { AdminService } from './admin.service';
import { OracleNativeService } from './oracle-native.service';
import { Roles } from '../auth/roles.decorator';

@ApiTags('admin')
@Controller('admin')
@Roles('ADMIN')
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly oracleNative: OracleNativeService,
  ) {}

  @Get('tables')
  @ApiOperation({ summary: 'List all managed admin tables' })
  listTables() {
    return AdminService.tables();
  }

  // ── Oracle import ──────────────────────────────────────────────

  @Post('oracle-import')
  @ApiOperation({
    summary:
      'Import configuration data directly from Oracle ODOO_INTEGRATION schema',
  })
  oracleImport(@Body() body: { tables?: string[] }) {
    return this.oracleNative.importFromOracle(body?.tables);
  }

  @Post('oracle-import/customer-accounts')
  @ApiOperation({
    summary:
      'Seed FusionCustomerAccount (account number → cust_account_id) from historical Oracle receipt/invoice tables',
  })
  importCustomerAccounts() {
    return this.oracleNative.importCustomerAccounts();
  }

  // ── CSV export/import ──────────────────────────────────────────

  @Get(':table/export')
  @ApiOperation({ summary: 'Export all records as CSV' })
  @ApiQuery({ name: 'region', required: false })
  async exportCsv(
    @Param('table') table: string,
    @Query('region') region: string | undefined,
    @Res() res: Response,
  ) {
    const csv = await this.adminService.exportCsv(table, region);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${table}-export.csv"`,
    );
    res.send(csv);
  }

  @Post(':table/import')
  @ApiOperation({ summary: 'Import records from a CSV file' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @UseInterceptors(FileInterceptor('file'))
  async importCsv(
    @Param('table') table: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('No file uploaded');
    const csvText = file.buffer.toString('utf-8');
    return this.adminService.importCsv(table, csvText);
  }

  // ── Generic CRUD ───────────────────────────────────────────────

  @Get(':table')
  @ApiOperation({ summary: 'List records for a table' })
  @ApiQuery({ name: 'skip', required: false })
  @ApiQuery({ name: 'take', required: false })
  @ApiQuery({ name: 'region', required: false })
  list(
    @Param('table') table: string,
    @Query('skip') skip?: string,
    @Query('take') take?: string,
    @Query('region') region?: string,
  ) {
    return this.adminService.list(table, {
      skip: skip ? Number(skip) : undefined,
      take: take ? Number(take) : undefined,
      region,
    });
  }

  @Get(':table/:id')
  @ApiOperation({ summary: 'Get single record by id' })
  getOne(@Param('table') table: string, @Param('id') id: string) {
    return this.adminService.getOne(table, id);
  }

  @Post(':table')
  @ApiOperation({ summary: 'Create a record' })
  create(@Param('table') table: string, @Body() body: Record<string, unknown>) {
    return this.adminService.create(table, body);
  }

  @Put(':table/:id')
  @ApiOperation({ summary: 'Update a record' })
  update(
    @Param('table') table: string,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.adminService.update(table, id, body);
  }

  @Delete(':table/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a record' })
  remove(@Param('table') table: string, @Param('id') id: string) {
    return this.adminService.remove(table, id);
  }
}
