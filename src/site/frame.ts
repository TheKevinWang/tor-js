/**
 * The persistent frame shell (`"client": { "shell": "frame" }`).
 *
 * A server-rendered site navigates on every click, and a document that holds a
 * WebRTC peer connection (or the host worker that keeps the Tor client alive)
 * must not unload. So the top-level document is this shell, which never
 * navigates, and the site runs in a full-viewport same-origin `<iframe>`:
 * clicks, form posts and redirects navigate only the iframe, with native
 * behaviour (scripts, forms, history, scroll restoration), and the shell keeps
 * the address bar and title in step with the page shown in it.
 *
 * Two roles share the page script (`tor-site.js`): the *shell* (this module's
 * `startFrameShell`) and, inside the iframe, a *frame* script
 * (`startFrameRole`) that exposes `window.torSite` and sends links that leave
 * the site to the top level.
 */

import type { TorSite } from './register.js';

/** Files of the static host that are the shell itself, never site content. */
const SHELL_FILES = ['index.html', '404.html', 'tor-shell.html'];

/**
 * The URL the iframe should load for a shell at `loc`: the same path, query and
 * hash, except that a request for one of the shell's own files means the site's
 * root (otherwise the shell would frame itself).
 */
export function initialFrameUrl(loc: { pathname: string; search: string; hash: string }, scopePath: string): string {
  const scope = scopePath.endsWith('/') ? scopePath : scopePath + '/';
  const rel = loc.pathname.startsWith(scope) ? loc.pathname.slice(scope.length) : null;
  const pathname = rel !== null && SHELL_FILES.includes(rel) ? scope : loc.pathname;
  return pathname + loc.search + loc.hash;
}

/**
 * What the shell's address bar should show for the iframe's current URL, or
 * null if it should not change (the frame left the site, or is blank).
 */
export function mirrorLocation(frameHref: string, shellOrigin: string): string | null {
  let u: URL;
  try {
    u = new URL(frameHref);
  } catch {
    return null;
  }
  if (u.origin !== shellOrigin) return null;
  return u.pathname + u.search + u.hash;
}

/** True for a link click that should leave the iframe: another origin, or an explicit `target="_top"`. */
export function leavesFrame(href: string, target: string | null, frameOrigin: string): boolean {
  let u: URL;
  try {
    u = new URL(href, frameOrigin);
  } catch {
    return false;
  }
  if (target === '_blank') return false; // opens its own window either way
  return u.origin !== frameOrigin || target === '_top';
}

/**
 * Run the shell: once the Service Worker controls the page, create the iframe,
 * show connection progress until it first loads, and keep the URL and title in
 * step with it.
 */
export function startFrameShell(sitePromise: Promise<TorSite>): void {
  const overlay = document.createElement('div');
  overlay.style.cssText =
    'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;' +
    'font:16px/1.5 system-ui,sans-serif;background:Canvas;color:CanvasText;z-index:2;text-align:center;padding:0 16px';
  overlay.innerHTML = '<h1 style="font-size:1.3rem">Connecting over Tor…</h1><p id="tor-shell-status" style="opacity:.7">Starting…</p>';
  document.body.append(overlay);
  const statusEl = overlay.querySelector('#tor-shell-status')!;

  sitePromise.then(
    async (site) => {
      // The iframe's first request must find this page's host, not a stale one
      // left by a previous shell (a reload), so wait until the Service Worker has it.
      await site.hostAttached;
      const scopePath = new URL(site.registration.scope).pathname;
      const show = (s: { state: string; message?: string }) => {
        statusEl.textContent = s.state === 'error' ? `Tor failed: ${s.message ?? 'unknown error'}` : `Tor: ${s.state}`;
      };
      show(site.status);
      site.onStatus(show);

      const frame = document.createElement('iframe');
      frame.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:0;z-index:1;background:Canvas';
      frame.setAttribute('title', document.title || 'site');
      let lastMirrored = '';
      const sync = () => {
        const w = frame.contentWindow;
        if (!w) return;
        let href: string;
        let title: string;
        try {
          href = w.location.href;
          title = w.document.title;
        } catch {
          return; // the frame is on another origin
        }
        const path = mirrorLocation(href, location.origin);
        if (path && path !== lastMirrored && path !== location.pathname + location.search + location.hash) {
          history.replaceState(history.state, '', path);
        }
        if (path) lastMirrored = path;
        if (title && title !== document.title) document.title = title;
      };
      frame.addEventListener('load', () => {
        overlay.remove(); // the first load that gets here is the site (or its error page)
        sync();
      });
      setInterval(sync, 500); // in-page changes (history.pushState, title edits) raise no event we can hear
      frame.src = initialFrameUrl(location, scopePath);
      document.body.append(frame);
    },
    (e) => {
      statusEl.textContent = `Tor failed: ${e instanceof Error ? e.message : String(e)}`;
    },
  );
}

/** Inside the iframe: expose the shell's `torSite` and send links that leave the site to the top level. */
export function startFrameRole(): void {
  try {
    const parent = window.parent as unknown as { torSite?: Promise<TorSite> };
    if (parent.torSite) (window as unknown as { torSite: Promise<TorSite> }).torSite = parent.torSite;
  } catch {
    // not same-origin: leave window.torSite unset
  }
  document.addEventListener(
    'click',
    (event) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
      const a = (event.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!a) return;
      if (leavesFrame(a.href, a.getAttribute('target'), location.origin)) {
        event.preventDefault();
        window.top!.location.href = a.href;
      }
    },
    true,
  );
}
