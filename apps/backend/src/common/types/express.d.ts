// Module augmentation (not the global Express.Request namespace — see
// authenticated-request.ts's own comment on why `user` is handled via that
// interface instead) for the one new field the integration API's guard
// attaches to the request: the resolved IntegrationApiKey. Staff API keys
// (src/common/guards/staff-api-key.guard.ts) don't need a field here at
// all — they resolve to a normal `request.user` (SessionUser), same as a
// cookie session would.
declare module 'express' {
  interface Request {
    integrationKey?: {
      id: string;
      restaurantId: string;
      branchId: string | null;
      scopes: string[];
    };
  }
}

export {};
