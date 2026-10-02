/**
 * Putting the adapter's page script into HTML that comes from the onion service.
 *
 * A server-rendered backend serves whole documents, none of which know about
 * the adapter. Without its script a document cannot keep the Service Worker
 * alive (browsers stop an idle one after ~30 s, taking a Tor client that lives
 * there with it), cannot report connection state, and cannot attach to a host
 * worker. So the Service Worker inserts one `<script>` tag into HTML responses
 * to navigations, as they stream past.
 */

/** The `<script>` tag for the adapter's page script (`tor-site.js`). Attribute values are escaped. */
export function pageScriptTag(urls: { script: string; sw: string; manifest: string }): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  return (
    `<script src="${esc(urls.script)}" data-sw="${esc(urls.sw)}" data-manifest="${esc(urls.manifest)}" ` +
    `data-prewarm="false" data-injected="true"></script>`
  );
}

/** Whether a response to `destination` with this `content-type` should get the script. */
export function shouldInject(destination: string, contentType: string | undefined): boolean {
  if (destination !== 'document') return false;
  if (!contentType) return false;
  const m = /^\s*text\/html\s*(?:;(.*))?$/i.exec(contentType);
  if (!m) return false;
  // The tag is ASCII, so any ASCII-compatible charset is safe; refuse the others.
  const charset = /charset\s*=\s*"?([^";\s]+)/i.exec(m[1] ?? '')?.[1]?.toLowerCase();
  return !charset || ['utf-8', 'utf8', 'us-ascii', 'iso-8859-1', 'latin1', 'windows-1252'].includes(charset);
}

/** How much of the start of a document is searched for a place to insert the tag. */
const SEARCH_LIMIT = 16 * 1024;

/**
 * A transform that inserts `tag` into an HTML byte stream right after the
 * opening `<head>` tag (else after `<html>`, else before `<body>`), never before
 * the doctype (which would put the page in quirks mode). A document with none of
 * those within the first 16 KB passes through unchanged. Everything after the
 * insertion point is passed through without being buffered.
 */
export function injectIntoHtml(tag: string): TransformStream<Uint8Array, Uint8Array> {
  const tagBytes = new TextEncoder().encode(tag);
  let held: Uint8Array = new Uint8Array(0);
  let done = false;

  /**
   * Offset at which to insert `tag` into `bytes`, or -1. `<head>` is preferred;
   * the fallbacks (`<html>`, `<body>`) are used only once `<head>` can no longer
   * be coming: a `<body>` has started, or the input is `final`.
   */
  const find = (bytes: Uint8Array, final: boolean): number => {
    // Latin-1 view: one char per byte, so offsets match and ASCII patterns work.
    let text = '';
    for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
    const head = /<head(?:\s[^>]*)?>/i.exec(text);
    if (head) return head.index + head[0].length;
    const html = /<html(?:\s[^>]*)?>/i.exec(text);
    const body = /<body[\s>]/i.exec(text);
    if (body) return html && html.index < body.index ? html.index + html[0].length : body.index;
    if (final && html) return html.index + html[0].length;
    return -1;
  };

  const emit = (controller: TransformStreamDefaultController<Uint8Array>, bytes: Uint8Array, at: number) => {
    if (at > 0) controller.enqueue(bytes.subarray(0, at));
    controller.enqueue(tagBytes);
    if (at < bytes.length) controller.enqueue(bytes.subarray(at));
  };

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (done) {
        if (chunk.length > 0) controller.enqueue(chunk);
        return;
      }
      const all = new Uint8Array(held.length + chunk.length);
      all.set(held, 0);
      all.set(chunk, held.length);
      const final = all.length >= SEARCH_LIMIT;
      const at = find(all, final);
      if (at >= 0) {
        emit(controller, all, at);
        done = true;
      } else if (final) {
        controller.enqueue(all); // nowhere to put it: pass the document through unchanged
        done = true;
      } else {
        held = all;
      }
      if (done) held = new Uint8Array(0);
    },
    flush(controller) {
      if (done || held.length === 0) return;
      const at = find(held, true);
      if (at >= 0) emit(controller, held, at);
      else controller.enqueue(held);
    },
  });
}
