/** An installed app is called only when it is on and both a URL and a secret are stored. */
export function appReceivesEvents(app: {
  enabled: boolean;
  baseUrl?: string | null;
  hasSecret: boolean;
}): boolean {
  return app.enabled && Boolean(app.baseUrl?.trim()) && app.hasSecret;
}
