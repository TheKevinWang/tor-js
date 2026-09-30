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
 */

import { registerTorSite, type RegisterOptions, type TorSite } from './register.js';

const script = document.currentScript as HTMLScriptElement | null;
const d = script?.dataset ?? {};
const opts: RegisterOptions = {};
if (d.sw) opts.sw = new URL(d.sw, document.baseURI).href;
if (d.manifest) opts.manifest = d.manifest;
if (d.scope) opts.scope = d.scope;
if (d.prewarm === 'false') opts.prewarm = false;
if (d.debug === 'true') opts.debug = true;

const promise: Promise<TorSite> = registerTorSite(opts);
promise.catch((e) => console.error('[tor-site]', e));
(window as unknown as { torSite: Promise<TorSite> }).torSite = promise;
