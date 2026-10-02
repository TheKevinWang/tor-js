/**
 * The Tor side of the site adapter: a Tor client plus the HTTP-semantics layer
 * and cookie jar that sit on top of it.
 *
 * `LocalBackend` owns a `TorClient` in whatever context it is constructed in
 * (the Service Worker, or the persistent host worker). It starts the client
 * lazily, waits for it before serving, and reports its state so pages can show
 * "connecting to Tor" instead of hanging silently.
 */

import { TorClient } from '../TorClient.js';
import type { RtcPeerFactory } from '../types.js';
import { Log, type LogLevel } from '../Log.js';
import { createAutoStorage } from '../storage/index.js';
import { withSanitizedGuards } from './guardState.js';
import { CookieJar, indexedDbCookieStore } from './cookieJar.js';
import type { SiteManifest } from './manifest.js';
import { TorHttp, errorResponse, type SiteRequest, type SiteResponse } from './torHttp.js';

export type SiteState = 'idle' | 'bootstrapping' | 'ready' | 'error';

export interface SiteStatus {
  state: SiteState;
  /** Set when `state` is "error". */
  message?: string;
  /** Where the Tor client runs: "host" (persistent worker) or "service-worker". */
  where?: 'host' | 'service-worker';
}

/** Anything that can serve a Tor-routed request. */
export interface SiteBackend {
  handle(req: SiteRequest): Promise<SiteResponse>;
  /** Connect to Tor now instead of on the first request. Resolves when connected; never rejects. */
  warm(): Promise<void>;
}

export interface LocalBackendOptions {
  manifest: SiteManifest;
  /** URL the manifest was loaded from; relative `client.*Url` values resolve against it. */
  manifestUrl: string;
  visibleOrigin: string;
  scopePath: string;
  where: 'host' | 'service-worker';
  onStatus?: (status: SiteStatus) => void;
  /** Receives the Tor client's log lines (at "info" and above) for the page's debug console. */
  onLog?: (level: LogLevel, message: string) => void;
  /** How long a request waits for Tor to become ready before failing. */
  readyTimeoutMs?: number;
  /** Creates WebRTC peer connections hosted by a page, for the WebRTC carrier (workers have none). */
  peerFactory?: RtcPeerFactory;
}

export class LocalBackend implements SiteBackend {
  private http: Promise<TorHttp> | null = null;
  private client: TorClient | null = null;
  private status: SiteStatus = { state: 'idle' };
  private readonly jar = new CookieJar(indexedDbCookieStore());

  constructor(private readonly opts: LocalBackendOptions) {}

  currentStatus(): SiteStatus {
    return this.status;
  }

  async warm(): Promise<void> {
    await this.ensure().catch(() => {});
  }

  async handle(req: SiteRequest): Promise<SiteResponse> {
    let http: TorHttp;
    try {
      http = await this.ensure();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return errorResponse(502, `Could not connect to Tor: ${msg}`);
    }
    return http.handle(req);
  }

  private setStatus(status: SiteStatus): void {
    this.status = { ...status, where: this.opts.where };
    this.opts.onStatus?.(this.status);
  }

  /** Stop the Tor client, if one was started. */
  close(): void {
    this.client?.close();
    this.client = null;
    this.http = null;
  }

  private ensure(): Promise<TorHttp> {
    if (this.http) return this.http;
    const { manifest, manifestUrl, visibleOrigin, scopePath } = this.opts;

    // The WebRTC carrier needs an RTCPeerConnection: global (a page) or borrowed
    // from a page (a factory). Without either, say so; never fall back to the
    // WebSocket carrier, which exposes the client to different parties.
    const hasRtc = typeof (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection !== 'undefined';
    if (manifest.client.snowflake === 'webrtc' && !this.opts.peerFactory && !hasRtc) {
      const err = new Error(
        'the WebRTC Snowflake carrier needs an open page of the site to host the peer connection, and none is attached '
        + '(open the site in a tab first, or use "client.snowflake": "websocket")',
      );
      this.setStatus({ state: 'error', message: err.message });
      return Promise.reject(err);
    }
    this.setStatus({ state: 'bootstrapping' });

    const bootstrapUrl = manifest.client.bootstrapUrl
      ? new URL(manifest.client.bootstrapUrl, manifestUrl).href
      : undefined;
    const client = new TorClient({
      snowflake: manifest.client.snowflake ?? true,
      rtcPeerFactory: this.opts.peerFactory,
      // The saved guard state is read without any 'disabled' mark: see guardState.ts.
      storage: withSanitizedGuards(createAutoStorage('tor-site')),
      bootstrapUrl,
      logLevel: 'info',
      log: new Log({
        rawLog: (level, ...args) => this.opts.onLog?.(level, args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ')),
      }),
    });

    this.client = client;
    const timeoutMs = this.opts.readyTimeoutMs ?? 120_000;
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Tor was not ready after ${timeoutMs / 1000}s`)), timeoutMs);
    });

    const attempt = Promise.race([client.ready(), timeout])
      .then(async () => {
        await this.jar.load();
        const http = new TorHttp({
          manifest, visibleOrigin, scopePath, jar: this.jar,
          fetch: (url, init) => client.fetch(url, init),
        });
        this.setStatus({ state: 'ready' });
        return http;
      })
      .catch((e) => {
        // Discard the failed client so the next request starts a fresh attempt.
        this.http = null;
        this.client = null;
        client.close();
        const message = e instanceof Error ? e.message : String(e);
        this.setStatus({ state: 'error', message });
        throw e;
      })
      .finally(() => clearTimeout(timer));
    this.http = attempt;
    return attempt;
  }
}
