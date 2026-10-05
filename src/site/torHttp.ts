/**
 * The HTTP-semantics layer between a static site and its onion backend.
 *
 * The Service Worker hands this class a request the browser made to the
 * site's own origin (`https://user.github.io/api/messages`) and gets back a
 * response the browser can use as if that origin had answered it. In between,
 * the request goes to the onion service through an injected `fetch` (the Tor
 * client's), and this class does the parts of being a browser that `fetch`
 * over raw Tor does not: cookies, gzip, redirects, and rewriting the two
 * headers (`Origin`, `Referer`) that name the site the request came from.
 *
 * It never contacts a host the manifest does not name.
 */

import type { FetchInit } from '../types.js';
import { abortError, isAbortError } from '../abort.js';
import type { CookieJar } from './cookieJar.js';
import { isAllowedOnion, visiblePathFor, type Route, type SiteManifest, type TorRule } from './manifest.js';
import { SiteRouter } from './router.js';
import { cookieDecision, refusal, type CookieDecision, type Initiator } from './requestPolicy.js';

/** A request in a form that survives postMessage: the Service Worker builds it from a `Request`. */
export interface SiteRequest {
  url: string;
  method: string;
  headers: [string, string][];
  body: Uint8Array | null;
  redirect?: 'follow' | 'manual' | 'error';
  signal?: AbortSignal;
  /** `Request.mode` ("navigate" for a link, form or typed URL). */
  mode?: string;
  /** `Request.credentials`; "omit" means no cookies are sent or stored. */
  credentials?: string;
  /**
   * Who started the request (see requestPolicy.ts). The Service Worker decides;
   * when absent the request counts as `unknown`: no state-changing methods, no
   * `SameSite=Strict` cookies, and no `Origin`/`Referer` sent on its behalf.
   */
  initiator?: Initiator;
}

export interface SiteResponse {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: ReadableStream<Uint8Array> | null;
}

export type TorFetch = (url: string, init: FetchInit) => Promise<Response>;

export interface TorHttpOptions {
  manifest: SiteManifest;
  /** The site's origin as the browser sees it, e.g. "https://user.github.io". */
  visibleOrigin: string;
  /** The Service Worker's scope path, e.g. "/" or "/repo/". */
  scopePath: string;
  fetch: TorFetch;
  jar: CookieJar;
}

/** Request headers never forwarded: hop-by-hop, set by us, or describing the browser rather than the request. */
const DROP_REQUEST = new Set([
  'host', 'connection', 'keep-alive', 'proxy-authorization', 'proxy-connection', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'content-length', 'cookie', 'cookie2', 'accept-encoding',
  'origin', 'referer', 'expect', 'user-agent',
]);

/** Response headers never passed to the page. */
const DROP_RESPONSE = new Set([
  'set-cookie', 'set-cookie2', 'connection', 'keep-alive', 'proxy-authenticate', 'te', 'trailer',
  'transfer-encoding', 'upgrade',
  // These would act on the *site's* origin, not on the backend: HSTS/alt-svc
  // pin transport behaviour, and Clear-Site-Data would wipe the site's storage.
  'strict-transport-security', 'alt-svc', 'clear-site-data', 'public-key-pins',
]);

/**
 * Every visitor looks the same to the backend, as in Tor Browser: the page's
 * own `User-Agent` is dropped (tor-js would otherwise forward the real
 * browser's, a fingerprint that Tor exists to remove) and this Firefox ESR
 * identity is sent instead. Backends that filter bots also tend to reject
 * requests that are missing the usual browser headers, so `Accept-Language`
 * gets Tor Browser's default when the page did not set one.
 */
export const TOR_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; rv:128.0) Gecko/20100101 Firefox/128.0';
const DEFAULT_ACCEPT_LANGUAGE = 'en-US,en;q=0.5';

const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

export class TorHttp {
  private readonly router: SiteRouter;
  private readonly scopePath: string;
  private readonly visibleOrigin: string;

  constructor(private readonly opts: TorHttpOptions) {
    this.router = new SiteRouter(opts.manifest, opts.visibleOrigin, opts.scopePath);
    this.scopePath = this.router.scopePath;
    this.visibleOrigin = this.router.visibleOrigin;
  }

  /** Where `url` is served from; see {@link SiteRouter.route}. */
  route(url: string): Route | null {
    return this.router.route(url);
  }

  async handle(req: SiteRequest): Promise<SiteResponse> {
    const route = this.route(req.url);
    if (!route || route.kind !== 'tor') {
      throw new Error(`TorHttp: ${req.url} is not routed to Tor`);
    }
    const search = new URL(req.url).search;
    const target = route.onion + route.path + search;
    const rule = this.router.ruleFor(req.url);
    const method = req.method.toUpperCase();
    // Checked here as well as in the Service Worker, so that no path to the onion skips it.
    const refused = refusal(req);
    if (refused) return errorResponse(403, `tor-site: ${refused}`);
    const cookies = cookieDecision(req);
    const hasBody = req.body !== null && req.body.byteLength > 0 && method !== 'GET' && method !== 'HEAD';

    const headers = this.requestHeaders(req, target, route.onion, method, cookies);
    let response: Response;
    try {
      response = await this.opts.fetch(target, {
        method,
        headers,
        ...(hasBody ? { body: req.body! } : {}),
        ...(req.signal ? { signal: req.signal } : {}),
      });
    } catch (e) {
      // An abort is the caller's decision, not a Tor failure: it stays an abort through the worker message boundary.
      if (req.signal?.aborted || isAbortError(e)) throw abortError(req.signal);
      return errorResponse(502, `Tor request to ${new URL(target).host} failed: ${describe(e)}`);
    }

    const raw = rawHeaders(response);
    if (cookies.store) {
      this.opts.jar.setFromResponse(
        target,
        raw.filter(([k]) => k === 'set-cookie').map(([, v]) => v),
      );
    }

    const encoding = (headerValue(raw, 'content-encoding') ?? '').trim().toLowerCase();
    const decoder = decoderFor(encoding);
    const out: [string, string][] = [];
    for (const [k, v] of raw) {
      if (DROP_RESPONSE.has(k) || k.startsWith('proxy-')) continue;
      if (decoder && (k === 'content-encoding' || k === 'content-length')) continue;
      if (k === 'location' || k === 'content-location') {
        out.push([k, this.visibleUrl(v, target, rule)]);
        continue;
      }
      out.push([k, v]);
    }

    let body: ReadableStream<Uint8Array> | null = response.body;
    if (method === 'HEAD' || NULL_BODY_STATUS.has(response.status)) {
      body = null;
      // Nothing will be read: release the Tor stream.
      response.body?.cancel().catch(() => {});
    } else if (body && decoder) {
      body = body.pipeThrough(new DecompressionStream(decoder) as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
    }
    return { status: response.status, statusText: response.statusText, headers: out, body };
  }

  // -------------------------------------------------------------------------

  private requestHeaders(
    req: SiteRequest,
    target: string,
    onion: string,
    method: string,
    cookies: CookieDecision,
  ): Record<string, string> {
    const out: Record<string, string> = {};
    let hasRange = false;
    for (const [name, value] of req.headers) {
      const k = name.toLowerCase();
      if (DROP_REQUEST.has(k) || k.startsWith('sec-') || k.startsWith('proxy-')) continue;
      if (k === 'range') hasRange = true;
      out[k] = k in out ? `${out[k]}, ${value}` : value;
    }
    // Backends check these to defend against cross-site forgery. A request one
    // of the site's own pages made comes, from the backend's point of view, from
    // its own origin, so it is labelled with the onion. Any other request is
    // never given that label: its Origin and Referer are not sent at all.
    if (req.initiator === 'same-origin') {
      if (req.headers.some(([k]) => k.toLowerCase() === 'origin')) out.origin = onion;
      if (req.headers.some(([k]) => k.toLowerCase() === 'referer')) out.referer = onion + '/';
    }
    out['user-agent'] = TOR_USER_AGENT;
    if (!('accept-language' in out)) out['accept-language'] = DEFAULT_ACCEPT_LANGUAGE;
    const cookie = cookies.send ? this.opts.jar.headerFor(target, Date.now(), { includeStrict: cookies.includeStrict }) : '';
    if (cookie) out.cookie = cookie;
    if (!hasRange && method !== 'HEAD') out['accept-encoding'] = 'gzip';
    return out;
  }

  /** Map a `Location` the backend sent to the URL the browser should follow. */
  private visibleUrl(value: string, base: string, rule: TorRule | undefined): string {
    let u: URL;
    try {
      u = new URL(value, base);
    } catch {
      return value;
    }
    if (!isAllowedOnion(this.opts.manifest, u.origin)) return value; // leaves the backend: not ours to rewrite
    const prefix = this.scopePath.slice(0, -1);
    if (this.opts.manifest.backendKnowsBase && prefix && (u.pathname === prefix || u.pathname.startsWith(prefix + '/'))) {
      // The backend was told where the site lives, so this is already a site path.
      return this.visibleOrigin + u.pathname + u.search + u.hash;
    }
    const visible = visiblePathFor(this.opts.manifest, u.origin, u.pathname, rule) ?? u.pathname;
    return this.visibleOrigin + prefix + visible + u.search + u.hash;
  }
}

function rawHeaders(res: Response): [string, string][] {
  const raw = (res as Response & { rawHeaders?: [string, string][] }).rawHeaders;
  if (Array.isArray(raw)) return raw.map(([k, v]) => [k.toLowerCase(), v]);
  const out: [string, string][] = [];
  res.headers.forEach((v, k) => out.push([k.toLowerCase(), v]));
  // A Response without rawHeaders (a plain fetch) exposes Set-Cookie separately.
  const getSetCookie = (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  if (getSetCookie && !out.some(([k]) => k === 'set-cookie')) {
    for (const v of getSetCookie.call(res.headers)) out.push(['set-cookie', v]);
  }
  return out;
}

function headerValue(raw: [string, string][], name: string): string | undefined {
  return raw.find(([k]) => k === name)?.[1];
}

function decoderFor(encoding: string): 'gzip' | 'deflate' | null {
  if (encoding === 'gzip' || encoding === 'x-gzip') return 'gzip';
  if (encoding === 'deflate') return 'deflate';
  return null;
}

function describe(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message);
  return String(e);
}

const STATUS_TEXT: Record<number, string> = { 403: 'Forbidden', 502: 'Bad Gateway', 503: 'Service Unavailable' };

/** A plain-text error page. Tor failures are reported, never retried over the clear web. */
export function errorResponse(status: number, message: string): SiteResponse {
  const bytes = new TextEncoder().encode(message + '\n');
  return {
    status,
    statusText: STATUS_TEXT[status] ?? '',
    headers: [
      ['content-type', 'text/plain; charset=utf-8'],
      ['x-tor-site-error', '1'],
      ['cache-control', 'no-store'],
    ],
    body: new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes);
        c.close();
      },
    }),
  };
}
