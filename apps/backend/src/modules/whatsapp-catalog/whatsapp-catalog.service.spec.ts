import { ConfigService } from '@nestjs/config';
import { WhatsAppCatalogService } from './whatsapp-catalog.service';

describe('whatsapp catalog connection', () => {
  function setup() {
    let row: Record<string, unknown> | null = null;
    const prisma = {
      whatsAppCatalogConnection: {
        findUnique: async ({ where }: { where: Record<string, string> }) => {
          if (!row) return null;
          if (where.branchId && row.branchId !== where.branchId) return null;
          if (where.phoneNumberId && row.phoneNumberId !== where.phoneNumberId) return null;
          if (where.id && row.id !== where.id) return null;
          return row;
        },
        findFirst: async () => row,
        create: async ({ data }: { data: Record<string, unknown> }) => {
          row = { id: 'conn-1', lastWebhookAt: null, ...data };
          return row;
        },
        update: async ({ data }: { data: Record<string, unknown> }) => {
          row = { ...row, ...data };
          return row;
        },
      },
      whatsAppCatalogProduct: {
        findMany: async () => [],
      },
      whatsAppCatalogSubmission: {
        findMany: async () => [],
      },
    };
    const config = {
      get: (key: string) => (key === 'JWT_SECRET' ? 'test-key-material-32-characters' : undefined),
    } as ConfigService;
    const service = new WhatsAppCatalogService(prisma as never, config);
    service.http = async () => ({ ok: true, status: 200, text: '{}' });
    return { service, read: () => row };
  }

  it('seals the token and resolves only the connected restaurant', async () => {
    const { service, read } = setup();
    const saved = await service.connect('rest-a', 'branch-a', {
      phoneNumberId: '111',
      wabaId: 'waba',
      catalogId: 'cat',
      accessToken: 'meta-token-value',
    });
    expect(saved.connected).toBe(true);
    expect(saved.verifyToken).toEqual(expect.any(String));
    expect(JSON.stringify(saved)).not.toContain('meta-token-value');
    expect(String(read()?.accessTokenSealed)).not.toBe('meta-token-value');
    expect(String(read()?.accessTokenSealed).startsWith('v1.')).toBe(true);

    const view = await service.get('branch-a');
    expect(view.accessTokenConfigured).toBe(true);
    expect(JSON.stringify(view)).not.toContain('meta-token-value');
    await expect(service.resolve('111')).resolves.toEqual({
      restaurantId: 'rest-a',
      branchId: 'branch-a',
    });
    await expect(service.resolve('999')).resolves.toBeNull();

    await service.disconnect('branch-a');
    expect(read()?.connectionStatus).toBe('DISCONNECTED');
    expect(read()?.accessTokenSealed).toBeNull();
    await expect(service.resolve('111')).resolves.toBeNull();
  });
});
