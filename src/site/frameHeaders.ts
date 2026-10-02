/**
 * Response headers for a Tor-served document that will be shown in the shell's
 * iframe (`"client": { "shell": "frame" }`).
 *
 * The backend was written for top-level use and may forbid framing
 * (`X-Frame-Options`, or `frame-ancestors` in its Content-Security-Policy),
 * which would break the shell. But the document must not become frameable by
 * *other* sites (clickjacking), so framing is allowed for the site's own
 * origin only: `frame-ancestors 'self'`.
 */

export function adaptForFrame(headers: [string, string][]): [string, string][] {
  const out: [string, string][] = [];
  for (const [name, value] of headers) {
    const k = name.toLowerCase();
    if (k === 'x-frame-options') continue;
    if (k === 'content-security-policy') {
      const kept = value
        .split(';')
        .map((d) => d.trim())
        .filter((d) => d !== '' && !/^frame-ancestors(\s|$)/i.test(d));
      // Everything else in the backend's policy stays in force.
      if (kept.length > 0) out.push([name, kept.join('; ')]);
      continue;
    }
    out.push([name, value]);
  }
  // A separate enforced policy: multiple Content-Security-Policy headers all apply.
  out.push(['content-security-policy', "frame-ancestors 'self'"]);
  return out;
}
