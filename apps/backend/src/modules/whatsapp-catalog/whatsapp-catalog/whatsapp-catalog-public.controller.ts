import {
  Controller,
  Get,
  Headers,
  PayloadTooLargeException,
  Post,
  Req,
  Res,
  UnauthorizedException,
  type RawBodyRequest,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { CatalogOrderService } from './catalog-order.service';
import { WhatsAppCatalogService } from './whatsapp-catalog.service';

@Controller('v1/public/whatsapp/catalog')
export class WhatsAppCatalogPublicController {
  constructor(
    private readonly catalog: WhatsAppCatalogService,
    private readonly orders: CatalogOrderService,
  ) {}

  @Get()
  async verify(@Req() req: RawBodyRequest<Request>, @Res() res: Response) {
    const challenge = await this.catalog.hubChallenge(req.query as Record<string, unknown>);
    if (!challenge) {
      res.status(403).type('text/plain').send('Forbidden');
      return;
    }
    res.status(200).type('text/plain').send(challenge);
  }

  @Post()
  async receive(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-hub-signature-256') signature: string | undefined,
    @Res() res: Response,
  ) {
    const raw = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    try {
      const result = await this.orders.receive(raw, signature, req.body);
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof PayloadTooLargeException) {
        res.status(413).json({ message: err.message });
        return;
      }
      const denied = err instanceof UnauthorizedException;
      res.status(denied ? 401 : 500).json({
        message: denied ? err.message : 'WhatsApp webhook failed',
      });
    }
  }
}
