/**
 * A small RFC 6265 cookie jar for the site adapter.
 *
 * The browser cannot do this job: `Set-Cookie` is a forbidden response header
 * (a `Response` built in script never carries it) and the browser would file
 * such a cookie under the wrong site anyway. So requests that go to an onion
 * service get their `Cookie` header from this jar, and responses feed it.
 *
 * Deliberate simplifications: no public-suffix list (the only hosts are onion
 * services and whatever the manifest names), `SameSite` is stored but not
 * enforced (every request comes from the one site that owns the jar), and
 * `Secure` cookies are sent over plain `http://` to `.onion` hosts, which are
 * end-to-end encrypted by Tor already.
 */

export interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  hostOnly: boolean;
  path: string;
  /** Epoch milliseconds, or null for a session cookie. */
  expires: number | null;
  secure: boolean;
  httpOnly: boolean;
  sameSite: string | null;
  created: number;
}

export interface CookieStore {
  load(): Promise<StoredCookie[]>;
  save(cookies: StoredCookie[]): Promise<void>;
}

const MAX_COOKIES = 300;
const MAX_COOKIE_BYTES = 4096;

export class CookieJar {
  private cookies: StoredCookie[] = [];
  private loaded = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly store?: CookieStore) {}

  /** Read persisted cookies. Safe to call repeatedly; only the first call reads. */
  async load(now = Date.now()): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.store) return;
    try {
      const saved = await this.store.load();
      this.cookies = saved.filter((c) => c.expires === null || c.expires > now);
    } catch {
      this.cookies = [];
    }
  }

  /** Apply the `Set-Cookie` header values of a response to `url`. */
  setFromResponse(url: string, setCookies: string[], now = Date.now()): void {
    const u = new URL(url);
    let changed = false;
    for (const header of setCookies) {
      const parsed = parseSetCookie(header, u, now);
      if (!parsed) continue;
      // Replace the cookie with the same identity, keeping its creation time.
      const i = this.cookies.findIndex(
        (c) => c.name === parsed.name && c.domain === parsed.domain && c.path === parsed.path,
      );
      if (i >= 0) parsed.created = this.cookies[i].created;
      if (parsed.expires !== null && parsed.expires <= now) {
        if (i >= 0) {
          this.cookies.splice(i, 1);
          changed = true;
        }
        continue;
      }
      if (i >= 0) this.cookies[i] = parsed;
      else this.cookies.push(parsed);
      changed = true;
    }
    if (changed) {
      this.evict();
      this.scheduleSave();
    }
  }

  /** The value of the `Cookie` request header for `url`, or "" when none apply. */
  headerFor(url: string, now = Date.now()): string {
    const u = new URL(url);
    const secure = isSecureUrl(u);
    const before = this.cookies.length;
    this.cookies = this.cookies.filter((c) => c.expires === null || c.expires > now);
    if (this.cookies.length !== before) this.scheduleSave();
    const host = u.hostname.toLowerCase();
    const path = u.pathname || '/';
    return this.cookies
      .filter((c) => (c.hostOnly ? host === c.domain : domainMatches(host, c.domain)))
      .filter((c) => pathMatches(path, c.path))
      .filter((c) => !c.secure || secure)
      .sort((a, b) => b.path.length - a.path.length || a.created - b.created)
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
  }

  /** Every stored cookie (tests and diagnostics). */
  all(): readonly StoredCookie[] {
    return this.cookies;
  }

  clear(): void {
    this.cookies = [];
    this.scheduleSave();
  }

  /** Persist now instead of waiting for the debounce. */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.store) await this.store.save(this.cookies.map((c) => ({ ...c })));
  }

  private scheduleSave(): void {
    if (!this.store || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush().catch((e) => console.warn('[tor-site] could not save cookies:', e));
    }, 50);
  }

  private evict(): void {
    if (this.cookies.length <= MAX_COOKIES) return;
    this.cookies.sort((a, b) => a.created - b.created);
    this.cookies.splice(0, this.cookies.length - MAX_COOKIES);
  }
}

function isSecureUrl(u: URL): boolean {
  return u.protocol === 'https:' || u.hostname.endsWith('.onion') || u.hostname === 'localhost'
    || u.hostname === '127.0.0.1';
}

function domainMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith('.' + domain);
}

function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/';
}

function defaultPath(u: URL): string {
  const p = u.pathname || '/';
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}

/** Parse one `Set-Cookie` header value received from `u`; null when it must be ignored. */
export function parseSetCookie(header: string, u: URL, now: number): StoredCookie | null {
  if (header.length > MAX_COOKIE_BYTES) return null;
  const parts = header.split(';');
  const first = parts[0];
  const eq = first.indexOf('=');
  if (eq <= 0) return null;
  const name = first.slice(0, eq).trim();
  const value = first.slice(eq + 1).trim();
  if (!name || /[\s\x00-\x1f\x7f]/.test(name)) return null;

  const host = u.hostname.toLowerCase();
  const cookie: StoredCookie = {
    name,
    value,
    domain: host,
    hostOnly: true,
    path: defaultPath(u),
    expires: null,
    secure: false,
    httpOnly: false,
    sameSite: null,
    created: now,
  };
  let maxAge: number | null = null;
  let expires: number | null = null;

  for (const attr of parts.slice(1)) {
    const j = attr.indexOf('=');
    const key = (j < 0 ? attr : attr.slice(0, j)).trim().toLowerCase();
    const val = j < 0 ? '' : attr.slice(j + 1).trim();
    switch (key) {
      case 'domain': {
        const d = val.replace(/^\./, '').toLowerCase();
        // A cookie may only widen to a parent domain of the host that set it,
        // and never to a bare top-level name such as "onion".
        if (!d || !d.includes('.') || !domainMatches(host, d)) return null;
        cookie.domain = d;
        cookie.hostOnly = false;
        break;
      }
      case 'path':
        if (val.startsWith('/')) cookie.path = val;
        break;
      case 'expires': {
        const t = Date.parse(val);
        if (!Number.isNaN(t)) expires = t;
        break;
      }
      case 'max-age':
        if (/^-?\d+$/.test(val)) maxAge = parseInt(val, 10);
        break;
      case 'secure':
        cookie.secure = true;
        break;
      case 'httponly':
        cookie.httpOnly = true;
        break;
      case 'samesite':
        cookie.sameSite = val.toLowerCase() || null;
        break;
    }
  }
  if (cookie.secure && !isSecureUrl(u)) return null;
  // Max-Age wins over Expires (RFC 6265 section 5.3).
  if (maxAge !== null) cookie.expires = maxAge <= 0 ? 0 : now + maxAge * 1000;
  else if (expires !== null) cookie.expires = expires;
  return cookie;
}

/**
 * The jar's IndexedDB database. It must not be `tor-site`: the Tor client's own
 * storage already owns a database of that name, with a different object store,
 * so a `kv` store could never be created in it and every save failed.
 */
export const COOKIE_DB = 'tor-site-cookies';

/** A store backed by one IndexedDB record; the default in workers and pages. */
export function indexedDbCookieStore(dbName = COOKIE_DB): CookieStore | undefined {
  if (typeof indexedDB === 'undefined') return undefined;
  const open = (): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  const run = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const req = fn(db.transaction('kv', mode).objectStore('kv'));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    } finally {
      db.close();
    }
  };
  return {
    async load() {
      const v = await run('readonly', (s) => s.get('cookies'));
      return Array.isArray(v) ? (v as StoredCookie[]) : [];
    },
    async save(cookies) {
      await run('readwrite', (s) => s.put(cookies, 'cookies'));
    },
  };
}
