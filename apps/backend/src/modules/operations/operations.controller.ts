import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
  UsePipes,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { memoryStorage } from 'multer';
import { ApiTags } from '@nestjs/swagger';
import {
  documentSchema,
  documentUpdateSchema,
  equipmentSchema,
  serviceLogSchema,
  type DocumentDto,
  type EquipmentDto,
  type ServiceLogDto,
  type SessionUser,
} from '@nodedr-restaurant/types';
import { Auth } from '../../common/decorators/auth.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { BranchAccessService } from '../../common/services/branch-access.service';
import { ATTACHMENT_MAX_BYTES, OperationsService } from './operations.service';

@ApiTags('operations')
@Controller('v1/operations')
export class OperationsController {
  constructor(
    private readonly ops: OperationsService,
    private readonly branchAccess: BranchAccessService,
  ) {}

  private access(u: SessionUser, branchId: string) {
    return this.branchAccess.assertAccess(u.restaurantId, branchId);
  }

  @Auth('operations.manage')
  @Get('equipment')
  async equipment(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
  ) {
    await this.access(u, branchId);
    return this.ops.listEquipment(branchId);
  }

  @Auth('operations.manage')
  @Post('equipment')
  @UsePipes(new ZodValidationPipe(equipmentSchema))
  async createEquipment(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Body() body: EquipmentDto,
  ) {
    await this.access(u, branchId);
    return this.ops.createEquipment(branchId, body);
  }

  @Auth('operations.manage')
  @Delete('equipment/:id')
  async retire(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
  ) {
    await this.access(u, branchId);
    return this.ops.retireEquipment(branchId, id);
  }

  @Auth('operations.manage')
  @Get('equipment/:id/logs')
  async logs(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
  ) {
    await this.access(u, branchId);
    return this.ops.listLogs(branchId, id);
  }

  @Auth('operations.manage')
  @Post('equipment/:id/logs')
  @UsePipes(new ZodValidationPipe(serviceLogSchema))
  async logService(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
    @Body() body: ServiceLogDto,
  ) {
    await this.access(u, branchId);
    return this.ops.logService(branchId, id, body);
  }

  @Auth('operations.manage')
  @Get('documents')
  async documents(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Query('category') category?: string,
  ) {
    await this.access(u, branchId);
    return this.ops.listDocuments(branchId, category);
  }

  @Auth('operations.manage')
  @Get('documents/:id')
  async document(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
  ) {
    await this.access(u, branchId);
    return this.ops.getDocument(branchId, id);
  }

  @Auth('operations.manage')
  @Post('documents')
  @UsePipes(new ZodValidationPipe(documentSchema))
  async createDocument(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Body() body: DocumentDto,
  ) {
    await this.access(u, branchId);
    return this.ops.createDocument(branchId, body);
  }

  @Auth('operations.manage')
  @Patch('documents/:id')
  @UsePipes(new ZodValidationPipe(documentUpdateSchema))
  async updateDocument(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
    @Body() body: Partial<DocumentDto>,
  ) {
    await this.access(u, branchId);
    return this.ops.updateDocument(branchId, id, body);
  }

  @Auth('operations.manage')
  @Delete('documents/:id')
  async deleteDocument(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
  ) {
    await this.access(u, branchId);
    return this.ops.deleteDocument(branchId, id);
  }

  @Auth('operations.manage')
  @Post('documents/:id/files')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: ATTACHMENT_MAX_BYTES, files: 1 },
    }),
  )
  async attach(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    await this.access(u, branchId);
    if (!file) throw new BadRequestException('Choose a file (max 5 MB)');
    return this.ops.addDocumentFile(branchId, id, file);
  }

  @Auth('operations.manage')
  @Get('documents/:id/files/:fileId')
  async download(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
    @Param('fileId') fileId: string,
    @Res() res: Response,
  ) {
    await this.access(u, branchId);
    const f = await this.ops.getDocumentFile(branchId, id, fileId);
    res.setHeader('Content-Type', f.mimeType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Always a download, never rendered inline: an uploaded file must not run
    // as a page on the app's origin.
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(f.fileName)}"`,
    );
    res.send(Buffer.from(f.data));
  }

  @Auth('operations.manage')
  @Delete('documents/:id/files/:fileId')
  async removeFile(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
    @Param('fileId') fileId: string,
  ) {
    await this.access(u, branchId);
    return this.ops.deleteDocumentFile(branchId, id, fileId);
  }
}
