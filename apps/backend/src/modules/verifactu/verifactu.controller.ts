import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Post,
  Put,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags } from '@nestjs/swagger';
import type { SessionUser } from '@nodedr-restaurant/types';
import { memoryStorage } from 'multer';
import { z } from 'zod';
import { Auth } from '../../common/decorators/auth.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { BranchAccessService } from '../../common/services/branch-access.service';
import { VerifactuService } from './verifactu.service';

const settingsSchema = z.object({
  enabled: z.boolean(),
  environment: z.enum(['TEST', 'PRODUCTION']),
  seriesPrefix: z.string().min(1).max(12),
});

@ApiTags('verifactu')
@Controller('v1/verifactu')
export class VerifactuController {
  constructor(
    private readonly service: VerifactuService,
    private readonly branchAccess: BranchAccessService,
  ) {}

  @Auth('settings.manage')
  @Get('settings')
  async settings(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.service.getSettings(user.restaurantId, branchId);
  }

  @Auth('settings.manage')
  @Put('settings')
  async save(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Body() body: unknown,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    const parsed = settingsSchema.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException('Invalid VERI*FACTU settings');
    return this.service.saveSettings(
      user.restaurantId,
      user.id,
      branchId,
      parsed.data,
    );
  }

  @Auth('settings.manage')
  @Post('certificate')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 256 * 1024 },
    }),
  )
  async certificate(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @UploadedFile() file: { buffer: Buffer } | undefined,
    @Body('password') password: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    if (!file)
      throw new BadRequestException(
        'Choose the .p12 or .pfx certificate file.',
      );
    return this.service.uploadCertificate(
      user.restaurantId,
      user.id,
      branchId,
      file.buffer,
      password ?? '',
    );
  }

  @Auth('settings.manage')
  @Get('records')
  async records(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.service.records(
      user.restaurantId,
      branchId,
      Number(take) || 50,
      Number(skip) || 0,
    );
  }

  @Auth('settings.manage')
  @Get('verify')
  async verify(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.service.verifyChain(user.restaurantId, branchId);
  }

  @Auth('settings.manage')
  @Post('send')
  async send(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.service.sendNow(user.restaurantId, branchId);
  }

  @Auth('settings.manage')
  @Get('export.xml')
  @Header('Content-Type', 'application/xml; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="verifactu-records.xml"')
  async export(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.service.exportXml(user.restaurantId, branchId);
  }
}
