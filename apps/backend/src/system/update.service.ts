import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';

export interface VersionInfo {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  // A newer release exists on GitHub but CI hasn't published its image yet.
  building: boolean;
  releaseUrl: string | null;
  checkedAt: string;
}

const GITHUB_REPO = 'Raktim94/nodedr-restaurant-pos';
// Avoid hammering GitHub's unauthenticated rate limit (60 req/hr per IP,
// shared across every self-hosted install behind the same egress IP in the
// worst case) — a check this infrequent is still fast enough to surface a
// new release the same day it ships. Same TTL as Submify/Zulivio's own
// update checkers, for consistency across the three products.
const CACHE_TTL_MS = 60 * 60 * 1000;
// A release whose image is still being built flips to "available" within
// minutes — don't let that state sit in the cache for the full hour.
const BUILDING_CACHE_TTL_MS = 60 * 1000;

@Injectable()
export class UpdateService {
  private readonly logger = new Logger(UpdateService.name);
  private cache: VersionInfo | null = null;
  private cacheExpiresAt = 0;

  async checkForUpdate(): Promise<VersionInfo> {
    if (this.cache && Date.now() < this.cacheExpiresAt) {
      return this.cache;
    }

    const currentVersion = (process.env.APP_VERSION ?? '').trim() || 'dev';
    let latestVersion: string | null = null;
    try {
      latestVersion = await this.fetchLatestTag();
    } catch (err) {
      this.logger.warn(
        `update check failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    let imagePublished = true;
    if (latestVersion && process.env.UPDATER_URL) {
      imagePublished = (await this.imageTagExists(latestVersion)) !== false;
    }

    const newer =
      latestVersion !== null &&
      (currentVersion === 'dev'
        ? !!process.env.UPDATER_URL
        : isNewer(latestVersion, currentVersion));
    const info: VersionInfo = {
      currentVersion,
      latestVersion,
      updateAvailable: newer && imagePublished,
      building: newer && !imagePublished,
      releaseUrl: latestVersion
        ? `https://github.com/${GITHUB_REPO}/releases/tag/${latestVersion}`
        : null,
      checkedAt: new Date().toISOString(),
    };
    this.cache = info;
    this.cacheExpiresAt =
      Date.now() +
      (info.building || latestVersion === null
        ? BUILDING_CACHE_TTL_MS
        : CACHE_TTL_MS);
    return info;
  }

  // Hands the update to the `updater` sidecar container (updater/server.js),
  // same design as nodedr-pos. A container can't safely replace itself, and
  // giving this API the Docker socket would be far more privilege than a POS
  // backend should hold — the sidecar is reachable only on the internal
  // Docker network, only with UPDATER_TOKEN, and only ever swaps the image
  // tag of the two app containers it is told to manage. It answers 202 right
  // away and carries on in the background (restarting this very container).
  async applyUpdate(): Promise<{ status: string; message: string }> {
    const base = (process.env.UPDATER_URL ?? '').trim().replace(/\/$/, '');
    if (!base) {
      throw new BadRequestException(
        'This install has no updater. Update the app the way you installed it.',
      );
    }
    this.cache = null; // force a fresh look at the latest version
    const info = await this.checkForUpdate();
    if (!info.updateAvailable || !info.latestVersion) {
      throw new ConflictException('You are already on the latest version');
    }

    let res: Response;
    try {
      res = await fetch(`${base}/v1/update`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.UPDATER_TOKEN ?? ''}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          version: info.latestVersion.replace(/^v/i, ''),
        }),
        signal: AbortSignal.timeout(10000),
      });
    } catch (err) {
      throw new InternalServerErrorException(
        `could not reach the updater: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new InternalServerErrorException(
        `updater refused: ${body.error ?? res.status}`,
      );
    }

    return {
      status: 'update started',
      message:
        'OrderlyPOS is updating and will restart shortly. The database is left as it is. This page will reload when OrderlyPOS is back.',
    };
  }

  // What the updater is doing right now, so the UI can surface a failure
  // (e.g. no internet to pull images) instead of waiting forever.
  async getProgress(): Promise<{
    state: string;
    step?: string | null;
    error?: string | null;
  }> {
    const base = (process.env.UPDATER_URL ?? '').trim().replace(/\/$/, '');
    if (!base) return { state: 'unavailable' };
    try {
      const res = await fetch(`${base}/v1/status`, {
        headers: { Authorization: `Bearer ${process.env.UPDATER_TOKEN ?? ''}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return { state: 'unknown' };
      return (await res.json()) as {
        state: string;
        step?: string | null;
        error?: string | null;
      };
    } catch {
      return { state: 'unknown' };
    }
  }

  // CI publishes the image shortly after a tag appears; updating inside that
  // window would pull nothing. Anonymous GHCR manifest check — anything other
  // than a clear 404 means "can't tell", and the tag is trusted.
  private async imageTagExists(tag: string): Promise<boolean | null> {
    try {
      const repo = 'raktim94/nodedr-restaurant-pos-backend';
      const version = tag.replace(/^v/i, '');
      const tokRes = await fetch(
        `https://ghcr.io/token?scope=repository:${repo}:pull`,
        { signal: AbortSignal.timeout(6000) },
      );
      if (!tokRes.ok) return null;
      const { token } = (await tokRes.json()) as { token: string };
      const res = await fetch(
        `https://ghcr.io/v2/${repo}/manifests/${version}`,
        {
          method: 'HEAD',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept:
              'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json',
          },
          signal: AbortSignal.timeout(6000),
        },
      );
      if (res.status === 404) return false;
      return res.ok ? true : null;
    } catch {
      return null;
    }
  }

  private async fetchLatestTag(): Promise<string | null> {
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/tags?per_page=30`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'nodedr-restaurant-pos-update-check',
        },
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!res.ok) return null;
    const tags = (await res.json()) as Array<{ name: string }>;
    const versions = tags
      .map((tag) => tag.name)
      .filter((name) => /^v?\d+\.\d+\.\d+$/.test(name));
    versions.sort((a, b) => (isNewer(a, b) ? -1 : 1));
    return versions[0] ?? null;
  }
}

function parseSemver(v: string): [number, number, number] {
  const parts = v
    .replace(/^v/i, '')
    .split('.')
    .map((n) => parseInt(n, 10));
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

function isNewer(latest: string, current: string): boolean {
  const [la, lb, lc] = parseSemver(latest);
  const [ca, cb, cc] = parseSemver(current);
  if (la !== ca) return la > ca;
  if (lb !== cb) return lb > cb;
  return lc > cc;
}
