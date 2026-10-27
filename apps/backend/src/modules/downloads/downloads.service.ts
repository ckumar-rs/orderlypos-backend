import { NotFoundException } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

// Fixed, server-side whitelist: the ONLY URLs this endpoint will ever
// redirect to. The client sends a channel key (an enum-like string, never a
// URL), so this can never become an open redirect — see the security
// hardening report's "unsafe URL handling / open redirects" check, which
// this is deliberately built to keep passing.
const DOWNLOAD_CHANNELS: Record<string, string> = {
  github: 'https://github.com/orderlypos',
  'install-script':
    'https://raw.githubusercontent.com/Raktim94/nodedr-restaurant-pos/master/install.sh',
  docker: 'https://github.com/orderlypos',
  casaos: 'https://github.com/IceWhaleTech/CasaOS-AppStore',
};

export type DownloadChannel = keyof typeof DOWNLOAD_CHANNELS;

@Injectable()
export class DownloadsService {
  constructor(private readonly prisma: PrismaService) {}

  resolveChannel(channel: string): string {
    const url = DOWNLOAD_CHANNELS[channel];
    if (!url) throw new NotFoundException('Unknown download channel');
    return url;
  }

  async recordAndResolve(channel: string): Promise<string> {
    const url = this.resolveChannel(channel);
    await this.prisma.downloadStat.upsert({
      where: { channel },
      create: { channel, count: 1 },
      update: { count: { increment: 1 } },
    });
    return url;
  }

  async stats(): Promise<{ channel: string; count: number }[]> {
    const rows = await this.prisma.downloadStat.findMany({
      orderBy: { channel: 'asc' },
    });
    // Always report every known channel, even ones with zero clicks yet —
    // an honest, complete picture rather than only rows that happen to
    // exist in the DB.
    const byChannel = new Map(rows.map((r) => [r.channel, r.count]));
    return Object.keys(DOWNLOAD_CHANNELS).map((channel) => ({
      channel,
      count: byChannel.get(channel) ?? 0,
    }));
  }
}
