/**
 * Who started a request that the site adapter is about to send to the onion
 * service, and what that request is therefore allowed to carry.
 *
 * Over an ordinary connection the browser protects a backend from cross-site
 * request forgery itself: it sends the true `Origin`, and it withholds
 * `SameSite` cookies from requests other sites start. Here the browser talks
 * to the Service Worker, and the adapter builds the request the backend sees,
 * attaching cookies from its own jar and naming the onion as the origin. So the
 * adapter must make those decisions, from what the Service Worker can observe.
 *
 * What a Service Worker sees (checked in Chromium): a request that is not a
 * navigation comes from a page the worker controls, so from the site itself.
 * A navigation (a link, a form submission, a typed URL) can come from anywhere;
 * `clients.get(event.clientId)` returns the page that started it only when that
 * page is on the site's own origin, and the `Origin` header and `referrer`
 * otherwise name the other site, unless a referrer policy hid them.
 */

/** `same-origin`: one of the site's own pages; `cross-site`: another site; `unknown`: no evidence either way. */
export type Initiator = 'same-origin' | 'cross-site' | 'unknown';

export interface InitiatorEvidence {
  /** `Request.mode`. */
  mode: string;
  /** Origin of the page that made the request, as `clients.get(event.clientId)` reports it (only same-origin pages are visible). */
  clientOrigin?: string | null;
  /** The request's `Origin` header as the Service Worker sees it; `"null"` when a referrer policy hid it. */
  originHeader?: string | null;
  /** `Request.referrer`: empty when a referrer policy hid it. */
  referrer?: string | null;
  /** The site's origin as the browser sees it, e.g. "https://user.github.io". */
  visibleOrigin: string;
}

export function classifyInitiator(e: InitiatorEvidence): Initiator {
  if (e.mode !== 'navigate') return 'same-origin';
  if (e.clientOrigin && e.clientOrigin === e.visibleOrigin) return 'same-origin';
  if (e.originHeader) return e.originHeader === e.visibleOrigin ? 'same-origin' : 'cross-site';
  if (e.referrer && e.referrer !== 'about:client') {
    try {
      return new URL(e.referrer).origin === e.visibleOrigin ? 'same-origin' : 'cross-site';
    } catch {
      return 'unknown';
    }
  }
  return 'unknown';
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** A method that may change state on the server. */
export function isUnsafeMethod(method: string): boolean {
  return !SAFE_METHODS.has(method.toUpperCase());
}

export interface PolicyInput {
  method: string;
  /** Absent means unknown: a caller that does not say who made the request gets the cautious treatment. */
  initiator?: Initiator;
  /** `Request.credentials`. */
  credentials?: string;
}

/**
 * Why the request must not be sent at all, or null when it may be. A request
 * that can change state is sent only when one of the site's own pages made it:
 * a form another site submits into a Tor route is answered locally and never
 * reaches the onion service.
 */
export function refusal(req: PolicyInput): string | null {
  const initiator = req.initiator ?? 'unknown';
  if (initiator === 'same-origin' || !isUnsafeMethod(req.method)) return null;
  const who = initiator === 'cross-site' ? 'another site' : 'a page that could not be identified as this site';
  return `refused a ${req.method.toUpperCase()} request started by ${who}: state-changing requests are sent to the onion service only when this site's own pages make them`;
}

export interface CookieDecision {
  /** Attach cookies from the jar. */
  send: boolean;
  /** Include `SameSite=Strict` cookies (only for requests the site's own pages made). */
  includeStrict: boolean;
  /** Keep the response's `Set-Cookie`. */
  store: boolean;
}

/**
 * Which cookies go with the request. `credentials: "omit"` sends and stores
 * none, as in a browser. Otherwise cookies are sent, except that `Strict` ones
 * are kept from requests the site's own pages did not provably make; the only
 * such requests that get this far are safe navigations (see {@link refusal}),
 * for which browsers send `Lax` and `None` cookies but not `Strict` ones.
 */
export function cookieDecision(req: PolicyInput): CookieDecision {
  if (req.credentials === 'omit') return { send: false, includeStrict: false, store: false };
  return { send: true, includeStrict: (req.initiator ?? 'unknown') === 'same-origin', store: true };
}
