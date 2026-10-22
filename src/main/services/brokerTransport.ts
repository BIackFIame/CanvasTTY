import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";

/**
 * The one HTTP client brokered model requests use (PluginAccountBroker). It is deliberately small and strict:
 *
 * - node's own http/https, never the environment's proxy settings and never a caller's options;
 * - no redirects (a 3xx is an error, never followed);
 * - TLS with certificate checks for every destination except an http offer on 127.0.0.1 or [::1];
 * - the address the connection really goes to is checked at connect time (the `lookup` the socket uses, so a DNS
 *   answer cannot change between a check and the connect): a public address for https offers, a loopback one for
 *   loopback offers.
 */

export interface BrokerUpstreamRequest {
  url: URL;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: Buffer;
  signal: AbortSignal;
  /** The offer is http on 127.0.0.1 or [::1]: only that loopback address may be reached. */
  loopback: boolean;
}

export interface BrokerUpstreamResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: AsyncIterable<Buffer>;
}

export type BrokerTransport = (request: BrokerUpstreamRequest) => Promise<BrokerUpstreamResponse>;

export class BrokerAddressError extends Error {}

/** True for addresses a brokered request must not reach unless the offer itself is loopback. */
export function isNonPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return nonPublicV4(address);
  if (family !== 6) return true;
  const lower = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (lower === "::" || lower === "::1") return true;
  // IPv4-mapped / -compatible / NAT64 forms carry an IPv4 address that decides.
  const embedded = /^(?:::ffff:|::|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (embedded) return nonPublicV4(embedded[1]!);
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (mappedHex) {
    const high = parseInt(mappedHex[1]!, 16);
    const low = parseInt(mappedHex[2]!, 16);
    return nonPublicV4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  const first = parseInt(lower.split(":")[0] || "0", 16);
  // fc00::/7 unique local, fe80::/10 link local, fec0::/10 site local, ff00::/8 multicast, 2001:db8::/32 docs.
  if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xffc0) === 0xfec0 || (first & 0xff00) === 0xff00) return true;
  if (lower.startsWith("2001:db8:") || lower.startsWith("2001:0db8:")) return true;
  return false;
}

function nonPublicV4(address: string): boolean {
  const [a, b] = address.split(".").map(Number) as [number, number, number, number];
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0)
    || (a === 198 && (b === 18 || b === 19));
}

const isLoopbackAddress = (address: string): boolean => {
  const lower = address.toLowerCase().replace(/^\[|\]$/g, "");
  return lower === "::1" || (isIP(lower) === 4 && lower.startsWith("127."));
};

/** The address check for one request, applied to every address the socket may connect to. */
export function addressAllowed(address: string, loopback: boolean): boolean {
  return loopback ? isLoopbackAddress(address) : !isNonPublicAddress(address);
}

export interface BrokerTransportOptions {
  /** For tests: the resolver the guarded lookup asks. */
  resolve?: (hostname: string) => Promise<LookupAddress[]>;
}

export function createBrokerTransport(options: BrokerTransportOptions = {}): BrokerTransport {
  const resolve = options.resolve ?? ((hostname: string) => new Promise<LookupAddress[]>((done, fail) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) => (error ? fail(error) : done(addresses)));
  }));
  return (request) => new Promise<BrokerUpstreamResponse>((done, fail) => {
    const { url, loopback } = request;
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (loopback ? url.protocol !== "http:" && url.protocol !== "https:" : url.protocol !== "https:") {
      fail(new BrokerAddressError("Only https is allowed (plain http only for 127.0.0.1 or [::1])."));
      return;
    }
    if (isIP(host) && !addressAllowed(host, loopback)) {
      fail(new BrokerAddressError("The destination is a private or local address."));
      return;
    }
    const lookup: LookupFunction = (hostname, lookupOptions, callback) => {
      resolve(hostname).then((addresses) => {
        const allowed = addresses.filter((entry) => addressAllowed(entry.address, loopback));
        if (allowed.length === 0 || allowed.length !== addresses.length) {
          callback(new BrokerAddressError("The destination resolves to a private or local address."), "", 4);
          return;
        }
        if ((lookupOptions as { all?: boolean }).all) (callback as unknown as (error: null, list: LookupAddress[]) => void)(null, allowed);
        else callback(null, allowed[0]!.address, allowed[0]!.family);
      }, (error: NodeJS.ErrnoException) => callback(error, "", 4));
    };
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const outgoing = send(url, {
      method: request.method,
      headers: { ...request.headers, ...(request.body ? { "content-length": String(request.body.length) } : {}) },
      lookup,
      agent: false,
      signal: request.signal,
      ...(url.protocol === "https:" ? { rejectUnauthorized: true, servername: isIP(host) ? undefined : host } : {})
    }, (response: IncomingMessage) => {
      done({ status: response.statusCode ?? 0, headers: response.headers, body: response });
    });
    outgoing.on("error", fail);
    outgoing.end(request.body);
  });
}
