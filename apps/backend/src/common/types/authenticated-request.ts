import type { SessionUser } from '@nodedr-restaurant/types';
import type { Request } from 'express';

export interface AuthenticatedRequest extends Request {
  user: SessionUser;
}
