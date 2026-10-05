// A small HTTP/1.1 server over onion-service connections: `serve(listener, handler)`.
//
// A hosted onion service hands out raw byte streams (src/host/types.ts). Most hosts want HTTP, so
// this turns each stream into one request and one response: it reads the request, builds a
// standard `Request`, calls the handler, and writes the `Response` back.
//
// It is deliberately strict and small, because it faces anonymous visitors: one request per
// connection (`Connection: close`), limits on the head and the body and on how long a visitor
// may take, and no guessing about ambiguous framing (a request with both Content-Length and
// Transfer-Encoding is refused, as is any Transfer-Encoding other than plain `chunked`).
//
// What a handler does not see: browsers' `Request` silently drops "forbidden" header names
// (Host, Cookie, Content-Length, Connection, ...), so in a browser those are absent from
// `request.headers`; the request URL carries the host. Node keeps them.

import type { Connection, Handler, Listener, ServeLimits } from './types.js';

const DEFAULTS = {
  maxHeadBytes: 16 * 1024,
  maxBodyBytes: 1024 * 1024,
  headTimeoutMs: 30_000,
  bodyTimeoutMs: 60_000,
} as const;

/** Raised inside this file to answer a visitor with an error status and close. */
class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

class TimeoutError extends Error {}

const encoder = new TextEncoder();

/** A response body of unknown length is read up to this many bytes before deciding how to frame it. */
const BUFFER_LIMIT = 64 * 1024;

const REASONS: Record<number, string> = {
  200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content', 206: 'Partial Content',
  301: 'Moved Permanently', 302: 'Found', 303: 'See Other', 304: 'Not Modified',
  307: 'Temporary Redirect', 308: 'Permanent Redirect',
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
  405: 'Method Not Allowed', 408: 'Request Timeout', 409: 'Conflict', 410: 'Gone',
  411: 'Length Required', 413: 'Content Too Large', 415: 'Unsupported Media Type',
  418: "I'm a teapot", 422: 'Unprocessable Content', 429: 'Too Many Requests',
  431: 'Request Header Fields Too Large', 500: 'Internal Server Error',
  501: 'Not Implemented', 502: 'Bad Gateway', 503: 'Service Unavailable',
  505: 'HTTP Version Not Supported',
};

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function indexOfSeq(haystack: Uint8Array, needle: number[], from = 0): number {
  outer: for (let i = from; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

const CRLF = [13, 10];
const CRLFCRLF = [13, 10, 13, 10];

/** Reads from a connection with a buffer, a deadline per phase, and exact-length reads. */
class ByteReader {
  buffer: Uint8Array = new Uint8Array(0);
  private eof = false;
  private deadline = Infinity;

  constructor(private readonly conn: Connection) {}

  /** Every read from now on must finish within `ms` of this call (for the whole phase). */
  startPhase(ms: number): void {
    this.deadline = Date.now() + ms;
  }

  /** Read more into the buffer. Returns false at the end of the stream. */
  async fill(): Promise<boolean> {
    if (this.eof) return false;
    const remaining = this.deadline - Date.now();
    if (remaining <= 0) throw new TimeoutError('timed out');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      if (remaining !== Infinity) timer = setTimeout(() => reject(new TimeoutError('timed out')), remaining);
    });
    try {
      const chunk = await Promise.race([this.conn.read(), timeout]);
      if (chunk === null) {
        this.eof = true;
        return false;
      }
      this.buffer = concat(this.buffer, chunk);
      return true;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Remove and return the first `n` buffered bytes. */
  take(n: number): Uint8Array {
    const out = this.buffer.subarray(0, n);
    this.buffer = this.buffer.subarray(n);
    return out;
  }

  /** Read until `delimiter`; return the bytes before it and consume it. */
  async readUntil(delimiter: number[], maxBytes: number, tooLong: HttpError): Promise<Uint8Array> {
    let from = 0;
    for (;;) {
      const at = indexOfSeq(this.buffer, delimiter, from);
      if (at >= 0) {
        if (at > maxBytes) throw tooLong;
        const head = this.take(at).slice();
        this.take(delimiter.length);
        return head;
      }
      if (this.buffer.length > maxBytes) throw tooLong;
      from = Math.max(0, this.buffer.length - delimiter.length + 1);
      if (!(await this.fill())) throw new HttpError(400, 'connection closed mid-request');
    }
  }

  /** Read exactly `n` bytes. */
  async readExact(n: number): Promise<Uint8Array> {
    while (this.buffer.length < n) {
      if (!(await this.fill())) throw new HttpError(400, 'connection closed mid-body');
    }
    return this.take(n).slice();
  }
}

function latin1(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

// RFC 9110 "token": the characters allowed in a method or header name.
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

interface ParsedHead {
  method: string;
  target: string;
  version: '1.0' | '1.1';
  headers: Headers;
}

function parseHead(text: string): ParsedHead {
  const lines = text.split('\r\n');
  const requestLine = lines[0];
  const parts = requestLine.split(' ');
  if (parts.length !== 3) throw new HttpError(400, 'malformed request line');
  const [method, target, protocol] = parts;
  if (!TOKEN.test(method)) throw new HttpError(400, 'malformed method');
  if (protocol !== 'HTTP/1.1' && protocol !== 'HTTP/1.0') {
    throw new HttpError(protocol.startsWith('HTTP/') ? 505 : 400, 'unsupported protocol version');
  }
  if (!target.startsWith('/')) throw new HttpError(400, 'only origin-form request targets are supported');
  const headers = new Headers();
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === '') throw new HttpError(400, 'empty header line');
    if (line[0] === ' ' || line[0] === '\t') throw new HttpError(400, 'obsolete header folding is not accepted');
    const colon = line.indexOf(':');
    if (colon <= 0) throw new HttpError(400, 'malformed header line');
    const name = line.slice(0, colon);
    if (!TOKEN.test(name)) throw new HttpError(400, 'malformed header name');
    try {
      headers.append(name, line.slice(colon + 1).trim());
    } catch {
      throw new HttpError(400, 'invalid header value');
    }
  }
  return { method, target, version: protocol === 'HTTP/1.1' ? '1.1' : '1.0', headers };
}

/** Read the request body described by the headers, within `maxBytes`. Returns null when there is none. */
async function readBody(reader: ByteReader, headers: Headers, maxBytes: number): Promise<Uint8Array | null> {
  const te = headers.get('transfer-encoding');
  const cl = headers.get('content-length');
  if (te !== null && cl !== null) throw new HttpError(400, 'both Content-Length and Transfer-Encoding');
  if (te !== null) {
    if (te.trim().toLowerCase() !== 'chunked') throw new HttpError(501, 'unsupported Transfer-Encoding');
    return readChunked(reader, maxBytes);
  }
  if (cl === null) return null;
  // A comma means several differing Content-Length values were sent: refuse, do not pick one.
  if (!/^[0-9]{1,15}$/.test(cl)) throw new HttpError(400, 'invalid Content-Length');
  const n = Number(cl);
  if (n > maxBytes) throw new HttpError(413, 'request body too large');
  if (n === 0) return new Uint8Array(0);
  return reader.readExact(n);
}

async function readChunked(reader: ByteReader, maxBytes: number): Promise<Uint8Array> {
  const tooLong = new HttpError(400, 'chunk header too long');
  let body: Uint8Array = new Uint8Array(0);
  for (;;) {
    const sizeLine = latin1(await reader.readUntil(CRLF, 1024, tooLong));
    const hex = sizeLine.split(';')[0].trim();
    if (!/^[0-9a-fA-F]{1,8}$/.test(hex)) throw new HttpError(400, 'invalid chunk size');
    const size = parseInt(hex, 16);
    if (size === 0) break;
    if (body.length + size > maxBytes) throw new HttpError(413, 'request body too large');
    body = concat(body, await reader.readExact(size));
    const end = await reader.readExact(2);
    if (end[0] !== 13 || end[1] !== 10) throw new HttpError(400, 'invalid chunk terminator');
  }
  // Trailers: read and discard lines up to the blank line that ends the message.
  for (let i = 0; ; i++) {
    if (i > 64) throw new HttpError(400, 'too many trailers');
    const line = await reader.readUntil(CRLF, 8 * 1024, new HttpError(431, 'trailer too long'));
    if (line.length === 0) break;
  }
  return body;
}

function statusLine(version: string, status: number, statusText: string): string {
  const text = (statusText || REASONS[status] || '').replace(/[^\t\x20-\x7e]/g, '');
  return `HTTP/${version} ${status} ${text}\r\n`;
}

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer']);

function headerBlock(headers: Headers, extra: Record<string, string>): string {
  let out = '';
  headers.forEach((value, name) => {
    if (HOP_BY_HOP.has(name) || name === 'content-length') return;
    out += `${name}: ${value}\r\n`;
  });
  for (const [name, value] of Object.entries(extra)) out += `${name}: ${value}\r\n`;
  return out + '\r\n';
}

async function sendError(conn: Connection, status: number, message: string): Promise<void> {
  const body = encoder.encode(message + '\n');
  const head =
    statusLine('1.1', status, '') +
    `content-type: text/plain; charset=utf-8\r\ncontent-length: ${body.length}\r\nconnection: close\r\n\r\n`;
  await conn.write(concat(encoder.encode(head), body));
}

/** Write `response` to `conn` as the answer to `method`/`version`. */
async function sendResponse(conn: Connection, response: Response, method: string, version: '1.0' | '1.1'): Promise<void> {
  const status = response.status;
  const bodyless = method === 'HEAD' || status === 204 || status === 205 || status === 304;
  const declared = response.headers.get('content-length');
  const known = declared !== null && /^[0-9]{1,15}$/.test(declared) ? Number(declared) : null;
  const reader = !bodyless && response.body ? response.body.getReader() : null;

  try {
    if (bodyless) {
      // HEAD keeps the length the handler declared; 204/205/304 carry no length at all.
      const extra: Record<string, string> = { connection: 'close' };
      if (method === 'HEAD' && known !== null) extra['content-length'] = String(known);
      await conn.write(encoder.encode(statusLine(version, status, response.statusText) + headerBlock(response.headers, extra)));
      return;
    }
    if (reader === null) {
      await conn.write(
        encoder.encode(statusLine(version, status, response.statusText) + headerBlock(response.headers, { 'content-length': '0', connection: 'close' })),
      );
      return;
    }
    if (version === '1.0') {
      // HTTP/1.0 has no chunked encoding: send the whole body with its length.
      let all: Uint8Array = new Uint8Array(0);
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        all = concat(all, value);
      }
      await conn.write(
        concat(
          encoder.encode(statusLine(version, status, response.statusText) + headerBlock(response.headers, { 'content-length': String(all.length), connection: 'close' })),
          all,
        ),
      );
      return;
    }
    if (known !== null) {
      // The handler declared a length: stream the body as is, and stop if it does not match.
      await conn.write(encoder.encode(statusLine(version, status, response.statusText) + headerBlock(response.headers, { 'content-length': String(known), connection: 'close' })));
      let sent = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        sent += value.length;
        if (sent > known) throw new Error('response body longer than its Content-Length');
        await conn.write(value);
      }
      if (sent !== known) throw new Error('response body shorter than its Content-Length');
      return;
    }
    // No length declared. Most bodies are small: read up to BUFFER_LIMIT first, and if the body
    // ends within it send an exact Content-Length (simpler for the visitor). Only a larger or
    // unfinished body is streamed chunked.
    const buffered: Uint8Array[] = [];
    let size = 0;
    let finished = false;
    while (size <= BUFFER_LIMIT) {
      const { done, value } = await reader.read();
      if (done) {
        finished = true;
        break;
      }
      if (value.length > 0) {
        buffered.push(value);
        size += value.length;
      }
    }
    if (finished) {
      const head = statusLine(version, status, response.statusText) + headerBlock(response.headers, { 'content-length': String(size), connection: 'close' });
      await conn.write(concat(encoder.encode(head), buffered.reduce(concat, new Uint8Array(0))));
      return;
    }
    await conn.write(encoder.encode(statusLine(version, status, response.statusText) + headerBlock(response.headers, { 'transfer-encoding': 'chunked', connection: 'close' })));
    const writeChunk = (value: Uint8Array) =>
      conn.write(concat(concat(encoder.encode(value.length.toString(16) + '\r\n'), value), encoder.encode('\r\n')));
    for (const value of buffered) await writeChunk(value);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.length === 0) continue; // a zero-length chunk would end the message
      await writeChunk(value);
    }
    await conn.write(encoder.encode('0\r\n\r\n'));
  } finally {
    reader?.cancel().catch(() => {});
  }
}

/**
 * Serve one connection: read a request, call `handler`, write the response, close.
 * Never throws; a failing connection is closed.
 */
export async function handleConnection(conn: Connection, handler: Handler, limits: ServeLimits = {}, defaultHost = 'localhost'): Promise<void> {
  const max = { ...DEFAULTS, ...stripUndefined(limits) };
  const reader = new ByteReader(conn);
  let method = 'GET';
  let version: '1.0' | '1.1' = '1.1';
  // Once any of the response is written, an error status can no longer be sent.
  let responding = false;
  try {
    reader.startPhase(max.headTimeoutMs);
    const headBytes = await reader.readUntil(CRLFCRLF, max.maxHeadBytes, new HttpError(431, 'request head too large'));
    const head = parseHead(latin1(headBytes));
    method = head.method;
    version = head.version;

    let body: Uint8Array | null = null;
    if (head.headers.get('expect')?.toLowerCase() === '100-continue' && version === '1.1') {
      await conn.write(encoder.encode('HTTP/1.1 100 Continue\r\n\r\n'));
    }
    reader.startPhase(max.bodyTimeoutMs);
    body = await readBody(reader, head.headers, max.maxBodyBytes);

    const hasBody = body !== null && body.length > 0;
    if (hasBody && (method === 'GET' || method === 'HEAD')) throw new HttpError(400, 'a GET or HEAD request must not have a body');

    let request: Request;
    try {
      const host = head.headers.get('host') || defaultHost;
      const url = new URL(head.target, `http://${host}`).href;
      // A Uint8Array is a valid fetch body; the cast is for TypeScript's older BodyInit typing.
      request = new Request(url, { method, headers: head.headers, body: hasBody ? (body as unknown as BodyInit) : undefined });
    } catch {
      throw new HttpError(400, 'malformed request');
    }

    let response: Response;
    try {
      const result = await handler(request);
      if (!(result instanceof Response)) throw new TypeError('handler did not return a Response');
      response = result;
    } catch {
      throw new HttpError(500, 'the handler failed');
    }
    responding = true;
    await sendResponse(conn, response, method, version);
  } catch (e) {
    try {
      if (responding) {
        // the response was cut short: closing the connection is the only signal left
      } else if (e instanceof HttpError) await sendError(conn, e.status, e.message);
      else if (e instanceof TimeoutError) await sendError(conn, 408, 'request timed out');
      // anything else: the connection is broken; there is no one to answer
    } catch {
      /* the visitor is gone */
    }
  } finally {
    try {
      await conn.close();
    } catch {
      /* already closed */
    }
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/**
 * Answer every visitor of `listener` with `handler`, until the listener is closed.
 *
 * The returned promise resolves when the listener has closed and no more visitors will come
 * (requests already being handled finish on their own).
 */
export async function serve(listener: Listener, handler: Handler, limits: ServeLimits = {}): Promise<void> {
  for (;;) {
    const conn = await listener.accept();
    if (conn === null) return;
    void handleConnection(conn, handler, limits, listener.onion);
  }
}
