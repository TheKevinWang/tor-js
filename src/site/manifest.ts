/**
 * The site manifest (`tor-site.json`): which paths of a static site are served
 * by the static host and which belong to a backend that is only reachable as a
 * Tor onion service.
 *
 *   {
 *     "version": 1,
 *     "onion": "http://abc...xyz.onion",
 *     "tor":    ["/api/**", "/login", { "match": "/duck/**", "strip": "/duck", "onion": "http://other.onion" }],
 *     "static": ["/assets/**"],
 *     "client": { "snowflake": true, "wasmUrl": "tor_js_bg.wasm", "bootstrapUrl": "bootstrap.zip.zst" }
 *   }
 *
 * `static` patterns are checked first, then `tor` patterns; a path matching
 * neither is static. Paths are relative to the Service Worker's scope, so a
 * site hosted at https://user.github.io/repo/ writes `/api/**` for
 * https://user.github.io/repo/api/.... `*` matches within one path segment,
 * `**` across segments, and a trailing `/**` also matches the bare directory.
 */

export interface TorRule {
  /** Original glob, kept for messages and tests. */
  match: string;
  regex: RegExp;
  /** Origin (scheme://host[:port]) of the onion service that serves this rule. */
  onion: string;
  /** Path prefix removed before the request is sent to the onion. */
  strip: string;
}

export interface ClientOptions {
  snowflake?: boolean | 'websocket';
  /** URL (relative to the manifest) of a directory snapshot; see TorClientOptions.bootstrapUrl. */
  bootstrapUrl?: string;
  /** URL (relative to the manifest) of tor_js_bg.wasm, for bundles that do not embed it. */
  wasmUrl?: string;
  /** Where the Tor client lives: a persistent worker when a page is open (default), or inside the Service Worker only. */
  host?: 'auto' | 'service-worker';
}

export interface SiteManifest {
  /** Every onion origin the manifest names; the only hosts the adapter will ever contact. */
  onions: string[];
  staticRules: RegExp[];
  torRules: TorRule[];
  client: ClientOptions;
}

export type Route =
  | { kind: 'static' }
  | { kind: 'tor'; onion: string; path: string };

export interface ParseOptions {
  /**
   * Accept hosts that are not `.onion` names. For tests against a local
   * server only; the Service Worker never sets it.
   */
  allowAnyHost?: boolean;
}

export function parseManifest(raw: unknown, opts: ParseOptions = {}): SiteManifest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('tor-site manifest: expected a JSON object');
  }
  const m = raw as Record<string, unknown>;
  if (m.version !== undefined && m.version !== 1) {
    throw new Error(`tor-site manifest: unsupported "version" ${JSON.stringify(m.version)} (expected 1)`);
  }

  const defaultOnion = m.onion === undefined ? undefined : parseOnion(m.onion, '"onion"', opts);
  const onions = new Set<string>();
  if (defaultOnion) onions.add(defaultOnion);

  const staticRules = asList(m.static, '"static"').map((entry, i) => {
    if (typeof entry !== 'string') {
      throw new Error(`tor-site manifest: "static"[${i}] must be a path pattern string`);
    }
    return globToRegExp(entry, `"static"[${i}]`);
  });

  const torRules = asList(m.tor, '"tor"').map((entry, i): TorRule => {
    const where = `"tor"[${i}]`;
    let match: string;
    let onion = defaultOnion;
    let strip = '';
    if (typeof entry === 'string') {
      match = entry;
    } else if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const e = entry as Record<string, unknown>;
      if (typeof e.match !== 'string') throw new Error(`tor-site manifest: ${where}.match must be a path pattern string`);
      match = e.match;
      if (e.onion !== undefined) onion = parseOnion(e.onion, `${where}.onion`, opts);
      if (e.strip !== undefined) strip = parseStrip(e.strip, where);
    } else {
      throw new Error(`tor-site manifest: ${where} must be a pattern string or an object with "match"`);
    }
    if (!onion) {
      throw new Error(`tor-site manifest: ${where} has no onion service; set a top-level "onion" or give the rule its own "onion"`);
    }
    onions.add(onion);
    return { match, regex: globToRegExp(match, where), onion, strip };
  });

  const client = parseClient(m.client);
  return { onions: [...onions], staticRules, torRules, client };
}

function asList(v: unknown, what: string): unknown[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new Error(`tor-site manifest: ${what} must be an array`);
  return v;
}

function parseOnion(v: unknown, what: string, opts: ParseOptions): string {
  if (typeof v !== 'string') throw new Error(`tor-site manifest: ${what} must be a URL string`);
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new Error(`tor-site manifest: ${what} is not a valid URL: ${JSON.stringify(v)}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`tor-site manifest: ${what} must be http:// or https://`);
  }
  if (!opts.allowAnyHost && !u.hostname.endsWith('.onion')) {
    throw new Error(`tor-site manifest: ${what} must be a .onion address (got ${u.hostname})`);
  }
  if ((u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) {
    throw new Error(`tor-site manifest: ${what} must be an origin only, without a path (got ${v})`);
  }
  return u.origin;
}

function parseStrip(v: unknown, where: string): string {
  if (typeof v !== 'string' || !v.startsWith('/')) {
    throw new Error(`tor-site manifest: ${where}.strip must be a path prefix starting with "/"`);
  }
  return v.replace(/\/+$/, '');
}

function parseClient(v: unknown): ClientOptions {
  if (v === undefined) return { snowflake: true, host: 'auto' };
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    throw new Error('tor-site manifest: "client" must be an object');
  }
  const c = v as Record<string, unknown>;
  const out: ClientOptions = { snowflake: true, host: 'auto' };
  if (c.snowflake !== undefined) {
    if (c.snowflake !== true && c.snowflake !== 'websocket') {
      // WebRTC needs RTCPeerConnection, which workers do not have.
      throw new Error('tor-site manifest: "client.snowflake" must be true or "websocket" (WebRTC does not exist in workers)');
    }
    out.snowflake = c.snowflake;
  }
  for (const key of ['bootstrapUrl', 'wasmUrl'] as const) {
    if (c[key] !== undefined) {
      if (typeof c[key] !== 'string') throw new Error(`tor-site manifest: "client.${key}" must be a string`);
      out[key] = c[key] as string;
    }
  }
  if (c.host !== undefined) {
    if (c.host !== 'auto' && c.host !== 'service-worker') {
      throw new Error('tor-site manifest: "client.host" must be "auto" or "service-worker"');
    }
    out.host = c.host;
  }
  return out;
}

/** Compile a path glob (see the file header) to an anchored RegExp. */
export function globToRegExp(glob: string, where = 'pattern'): RegExp {
  if (!glob.startsWith('/')) {
    throw new Error(`tor-site manifest: ${where} ${JSON.stringify(glob)} must start with "/"`);
  }
  let g = glob;
  let optionalTail = false;
  if (g.endsWith('/**')) {
    g = g.slice(0, -3);
    optionalTail = true;
  }
  let src = '';
  for (let i = 0; i < g.length; ) {
    if (g.startsWith('**', i)) {
      src += '.*';
      i += 2;
    } else if (g[i] === '*') {
      src += '[^/]*';
      i += 1;
    } else {
      src += g[i].replace(/[.+?^${}()|[\]\\]/g, '\\$&');
      i += 1;
    }
  }
  if (optionalTail) src += '(?:/.*)?';
  return new RegExp(`^${src}$`);
}

/** Decide where a path (relative to the site's scope, starting with "/") is served from. */
export function routeFor(manifest: SiteManifest, pathname: string): Route {
  const hit = matchTorRule(manifest, pathname);
  return hit ? { kind: 'tor', onion: hit.rule.onion, path: hit.path } : { kind: 'static' };
}

/** The `tor` rule that serves `pathname` (and the path to request from its onion), or null for a static path. */
export function matchTorRule(manifest: SiteManifest, pathname: string): { rule: TorRule; path: string } | null {
  for (const re of manifest.staticRules) {
    if (re.test(pathname)) return null;
  }
  for (const rule of manifest.torRules) {
    if (rule.regex.test(pathname)) return { rule, path: stripPrefix(pathname, rule.strip) };
  }
  return null;
}

/** Remove `strip` from the front of `path` at a segment boundary; the result always starts with "/". */
export function stripPrefix(path: string, strip: string): string {
  if (!strip) return path;
  if (path === strip) return '/';
  if (path.startsWith(strip + '/')) return path.slice(strip.length);
  return path;
}

/**
 * The inverse of `routeFor` for redirects: the site-relative path on which a
 * path of `onion` is served, or null when no `tor` rule exposes it. Rules are
 * tried in order, `prefer` (the rule the request itself came through) first,
 * because several rules may expose the same onion under different prefixes.
 */
export function visiblePathFor(manifest: SiteManifest, onion: string, path: string, prefer?: TorRule): string | null {
  const rules = prefer ? [prefer, ...manifest.torRules.filter((r) => r !== prefer)] : manifest.torRules;
  const host = new URL(onion).host;
  for (const rule of rules) {
    if (new URL(rule.onion).host !== host) continue;
    const candidate = rule.strip ? rule.strip + (path === '/' ? '/' : path) : path;
    if (routeFor(manifest, candidate).kind === 'tor' && rule.regex.test(candidate)) return candidate;
  }
  return null;
}

/**
 * The manifest's own origin for the onion service `origin` names, or undefined
 * when the manifest does not name it. Matching is by host, not scheme: a
 * backend that redirects http to https, or a page that writes the other
 * scheme, still reaches the service the manifest chose (with its scheme).
 */
export function canonicalOnion(manifest: SiteManifest, origin: string): string | undefined {
  const host = new URL(origin).host;
  return manifest.onions.find((o) => new URL(o).host === host);
}

export function isAllowedOnion(manifest: SiteManifest, origin: string): boolean {
  return canonicalOnion(manifest, origin) !== undefined;
}
