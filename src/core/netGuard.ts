// SSRF guard for fetches of URLs that come from third parties: competitor pages from a SERP, the
// outbound links a crawled page carries, and every redirect they answer with. Such a URL (or a
// redirect, or a DNS name) can point at 169.254.169.254, 10.x, 127.0.0.1 or ::1, and the response
// came back to the model (a competitor fetch returned instance-metadata text into the recon packet).
// The check runs where the socket is opened, on the address actually connected to, so it covers
// every redirect hop and a DNS name that resolves to a private address (rebinding included).
// The user's OWN site is not fetched through here: a local or intranet property is legitimate.
import dns from 'node:dns';
import net from 'node:net';
import { Agent, buildConnector } from 'undici';

const blocked = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(addr, prefix, 'ipv4');
for (const [addr, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32]] as const) blocked.addSubnet(addr, prefix, 'ipv6');

let allowPrivate = false;
/** Test seam only: the probes stand local 127.0.0.1 servers in for third-party hosts. */
export function allowPrivateAddressesForTests(on: boolean): void { allowPrivate = on; }

/** True for an address a third-party URL may reach: not loopback, private, link-local, CGNAT, reserved or multicast. */
export function isPublicAddress(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, '');
  const v = net.isIP(bare);
  if (!v) return false;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(bare); // IPv4-mapped IPv6
  if (mapped) return !blocked.check(mapped[1], 'ipv4');
  return !blocked.check(bare, v === 4 ? 'ipv4' : 'ipv6');
}

export class BlockedAddressError extends Error {
  readonly code = 'EBLOCKEDADDRESS';
  constructor(host: string, ip: string) { super(`refused: ${host} resolves to ${ip}, a private or local address (SSRF guard)`); }
}

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;
/** dns.lookup that fails when any resolved address is not public. */
function publicLookup(hostname: string, options: dns.LookupOptions, callback: LookupCb): void {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, [] as dns.LookupAddress[]);
    const list = addresses as dns.LookupAddress[];
    const bad = allowPrivate ? undefined : list.find(a => !isPublicAddress(a.address));
    if (bad) return callback(new BlockedAddressError(hostname, bad.address), [] as dns.LookupAddress[]);
    if (options.all) return callback(null, list);
    const first = list[0];
    return first ? callback(null, first.address, first.family) : callback(Object.assign(new Error(`no address for ${hostname}`), { code: 'ENOTFOUND' }), [] as dns.LookupAddress[]);
  });
}

/**
 * An undici Agent that only connects to public addresses: a literal IP is checked before the
 * connect, a name through its DNS answer. Use it as the dispatcher for third-party URLs.
 */
export function publicOnlyAgent(options: ConstructorParameters<typeof Agent>[0] = {}): Agent {
  const connector = buildConnector({ lookup: publicLookup } as buildConnector.BuildOptions);
  return new Agent({
    ...options,
    connect: (opts, callback) => {
      const host = String(opts.hostname ?? '').replace(/^\[|\]$/g, '');
      if (!allowPrivate && net.isIP(host) && !isPublicAddress(host)) { callback(new BlockedAddressError(host, host), null); return; }
      connector(opts, callback);
    },
  });
}
