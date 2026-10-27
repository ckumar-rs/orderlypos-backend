import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Res,
  UsePipes,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import archiver from 'archiver';
import * as fs from 'node:fs/promises';
import type { Response } from 'express';
import {
  restoreBackupSchema,
  setBackupConfigSchema,
  type SessionUser,
} from '@nodedr-restaurant/types';
import { Auth } from '../common/decorators/auth.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { BackupService } from './backup.service';

// Backups span the whole instance (every restaurant sharing this
// database), so visibility is restricted well above the usual
// `settings.manage` tier: any read leaks the existence/timing of a
// full-instance dump. `backup.manage` is a dedicated permission (not
// reused from settings.manage) specifically so it can be granted to a
// custom role narrowly, without also granting general settings access.
// Restore additionally re-checks the caller's role inside
// `BackupService.restore()` itself — see that method's comment for why.
@ApiTags('backups')
@Controller('v1/backups')
export class BackupController {
  constructor(private readonly backupService: BackupService) {}

  @Auth('backup.manage')
  @Get('status')
  status() {
    return this.backupService.status();
  }

  @Auth('backup.manage')
  @Get()
  list() {
    return this.backupService.list();
  }

  @Auth('backup.manage')
  @Post('config')
  @UsePipes(new ZodValidationPipe(setBackupConfigSchema))
  setConfig(@CurrentUser() user: SessionUser, @Body() body: unknown) {
    return this.backupService.setConfig(user, body as never);
  }

  @Auth('backup.manage')
  @Delete('config')
  clearConfig(@CurrentUser() user: SessionUser) {
    return this.backupService.clearConfig(user);
  }

  @Auth('backup.manage')
  @Post()
  trigger(@CurrentUser() user: SessionUser) {
    return this.backupService.triggerManual(user);
  }

  @Auth('backup.manage')
  @Post(':id/restore')
  @UsePipes(new ZodValidationPipe(restoreBackupSchema))
  restore(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.backupService.restore(user, id, body as never);
  }

  // Streams a single zip built server-side from the backup's two S3
  // objects (whichever exist) — new beyond zulivio, which never built a
  // local-download path. See BackupService.prepareDownload() for the
  // VERIFIED-only check and its own audit call.
  // Local backup: dump the database + uploads right now and stream them as
  // a zip to the browser, so an owner can keep a copy on their own machine
  // with no S3 bucket configured. Declared before ':id/download' routes.
  @Auth('backup.manage')
  @Get('export')
  async exportLocal(@CurrentUser() user: SessionUser, @Res() res: Response) {
    const { workDir, dbDumpPath, uploadsArchivePath } =
      await this.backupService.prepareLocalExport(user);

    const filename = `orderrestro-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    const cleanup = () => {
      void fs.rm(workDir, { recursive: true, force: true });
    };
    res.on('close', cleanup);

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', (err) => res.destroy(err));
    archive.pipe(res);
    archive.file(dbDumpPath, { name: 'db.dump' });
    if (uploadsArchivePath) {
      archive.file(uploadsArchivePath, { name: 'uploads.tar.gz' });
    }
    await archive.finalize();
  }

  @Auth('backup.manage')
  @Get(':id/download')
  async download(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    const { record, config, s3 } = await this.backupService.prepareDownload(
      user,
      id,
    );

    const filename = `backup-${record.createdAt.toISOString().replace(/[:.]/g, '-')}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', (err) => res.destroy(err));
    archive.pipe(res);

    if (record.s3KeyDb) {
      const dbStream = await this.backupService.fetchObjectStream(
        s3,
        config.bucket,
        record.s3KeyDb,
      );
      archive.append(dbStream, { name: 'db.dump' });
    }
    if (record.s3KeyUploads) {
      const uploadsStream = await this.backupService.fetchObjectStream(
        s3,
        config.bucket,
        record.s3KeyUploads,
      );
      archive.append(uploadsStream, { name: 'uploads.tar.gz' });
    }

    await archive.finalize();
  }
}
