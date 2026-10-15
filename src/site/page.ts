/**
 * The classic-script form of the page API, for sites that just add a tag:
 *
 *   <script src="tor-site.js" data-sw="tor-site-sw.js" data-manifest="tor-site.json"></script>
 *
 * It registers the worker immediately and publishes `window.torSite`, a
 * promise for the {@link TorSite} that resolves once the worker controls the
 * page. The site's own scripts wait on it before their first request to a Tor
 * path:
 *
 *   const site = await window.torSite;
 *
 * Add `data-loading="screen"` (or "true") to cover the page with a loading screen (what is
 * being set up and why it takes a moment, progress, details for technical visitors,
 * retry on failure) until Tor is connected. Add `data-loading="transparent"` for no
 * screen at all: Tor connects in the background while the visitor reads the page, and
 * is ready by the time they do something that needs the server (leave a comment); if
 * they are quicker than Tor, a small notice says the request is waiting. Either way a
 * "Private connection" badge stays in the corner; `data-badge="false"` hides it.
 */

import { registerTorSite, type RegisterOptions, type TorSite } from './register.js';
import { startFrameRole, startFrameShell } from './frame.js';
import { showLoadingScreen } from './loading.js';
import { showConnectionBadge } from './badge.js';

const script = document.currentScript as HTMLScriptElement | null;
const d = script?.dataset ?? {};

if (d.role === 'frame') {
  // Inside the shell's iframe: nothing to register, the shell owns the site.
  startFrameRole();
} else {
  const opts: RegisterOptions = {};
  if (d.sw) opts.sw = new URL(d.sw, document.baseURI).href;
  if (d.manifest) opts.manifest = d.manifest;
  if (d.scope) opts.scope = d.scope;
  if (d.host) opts.hostScript = new URL(d.host, document.baseURI).href;
  // Transparent loading means connecting at once, so it overrides data-prewarm="false".
  if (d.prewarm === 'false' && d.loading !== 'transparent') opts.prewarm = false;
  if (d.debug === 'true') opts.debug = true;

  const promise: Promise<TorSite> = registerTorSite(opts);
  promise.catch((e) => console.error('[tor-site]', e));
  (window as unknown as { torSite: Promise<TorSite> }).torSite = promise;

  // The persistent shell: show the site in an iframe once Tor is reachable.
  if (d.shell === 'frame') {
    const start = () => {
      startFrameShell(promise);
      if (d.badge !== 'false') showConnectionBadge(promise);
    };
    if (document.body) start();
    else document.addEventListener('DOMContentLoaded', start, { once: true });
  } else if (d.loading === 'true' || d.loading === 'screen' || d.loading === 'transparent') {
    // "screen" (or "true"): cover the page with the loading screen until Tor is connected.
    // "transparent": no screen; Tor connects in the background from the moment the page loads, the
    // visitor carries on, and only a request that needs Tor before it is ready shows a notice.
    const screen = d.loading !== 'transparent';
    const start = () => {
      if (screen) showLoadingScreen(promise, { until: 'ready' });
      if (d.badge !== 'false') showConnectionBadge(promise);
    };
    if (document.body) start();
    else document.addEventListener('DOMContentLoaded', start, { once: true });
  }
}
