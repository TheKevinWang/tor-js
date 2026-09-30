/**
 * Decides, for a URL the browser is requesting, whether the site adapter
 * handles it (over Tor) or leaves it to the browser (static host). Needs only
 * the manifest and where the site lives, so the Service Worker can use it
 * without a Tor client, cookie jar or anything else heavy.
 */

import { canonicalOnion, matchTorRule, routeFor, type Route, type SiteManifest, type TorRule } from './manifest.js';

export class SiteRouter {
  /** The Service Worker's scope path, always ending in "/". */
  readonly scopePath: string;
  /** The site's origin as the browser sees it, e.g. "https://user.github.io". */
  readonly visibleOrigin: string;

  constructor(
    private readonly manifest: SiteManifest,
    visibleOrigin: string,
    scopePath: string,
  ) {
    this.scopePath = scopePath.endsWith('/') ? scopePath : scopePath + '/';
    this.visibleOrigin = new URL(visibleOrigin).origin;
  }

  /**
   * Where `url` is served from, or null when the adapter has no opinion (it is
   * outside the scope or on a foreign host) and the browser should handle it.
   */
  route(url: string | URL): Route | null {
    const u = this.parse(url);
    if (!u) return null;
    if (u.origin === this.visibleOrigin) {
      const rel = this.relativePath(u.pathname);
      return rel === null ? null : routeFor(this.manifest, rel);
    }
    const onion = canonicalOnion(this.manifest, u.origin);
    if (onion) {
      // A page addressed the onion directly: there is only one place it can go.
      return { kind: 'tor', onion, path: u.pathname };
    }
    return null;
  }

  /** The manifest rule a visible-origin URL was routed by (undefined for direct onion URLs). */
  ruleFor(url: string | URL): TorRule | undefined {
    const u = this.parse(url);
    if (!u || u.origin !== this.visibleOrigin) return undefined;
    const rel = this.relativePath(u.pathname);
    return rel === null ? undefined : matchTorRule(this.manifest, rel)?.rule;
  }

  private parse(url: string | URL): URL | null {
    if (url instanceof URL) return url;
    try {
      return new URL(url);
    } catch {
      return null;
    }
  }

  private relativePath(pathname: string): string | null {
    if (pathname.startsWith(this.scopePath)) return '/' + pathname.slice(this.scopePath.length);
    if (pathname + '/' === this.scopePath) return '/';
    return null;
  }
}
