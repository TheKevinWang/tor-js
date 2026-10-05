// The error a build without hosting gives when asked to host (see
// .agent/host-pow-and-optional-host-execplan.md): the default `tor-js` build leaves the service
// code out so its WASM stays small, and the `tor-js/host` build includes it.

export const HOSTING_UNAVAILABLE_MESSAGE =
  'Hosting an onion service is not part of this build of tor-js. ' +
  'Import from "tor-js/host" (or "tor-js/host/wasm-file", "tor-js/host/wasm-base64") instead of "tor-js"; ' +
  'that build includes it. The default build leaves it out to keep the WASM small.';

export class HostingUnavailableError extends Error {
  constructor() {
    super(HOSTING_UNAVAILABLE_MESSAGE);
    this.name = 'HostingUnavailableError';
  }
}
