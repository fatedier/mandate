import { BlockList, isIP } from "node:net";

// Loopback, private and link-local ranges: an address here is this machine or
// its network, never the provider a public price list describes.
const PRIVATE = new BlockList();
PRIVATE.addSubnet("0.0.0.0", 8, "ipv4");
PRIVATE.addSubnet("127.0.0.0", 8, "ipv4");
PRIVATE.addSubnet("10.0.0.0", 8, "ipv4");
PRIVATE.addSubnet("172.16.0.0", 12, "ipv4");
PRIVATE.addSubnet("192.168.0.0", 16, "ipv4");
PRIVATE.addSubnet("169.254.0.0", 16, "ipv4");
// Shared address space (carrier NAT, and Tailscale's addresses).
PRIVATE.addSubnet("100.64.0.0", 10, "ipv4");
PRIVATE.addAddress("::", "ipv6");
PRIVATE.addAddress("::1", "ipv6");
PRIVATE.addSubnet("fc00::", 7, "ipv6");
PRIVATE.addSubnet("fe80::", 10, "ipv6");

/** Names only a local network resolves: mDNS, common home and internal
 *  domains, and Tailscale's. */
const LOCAL_SUFFIXES = [".local", ".lan", ".internal", ".home.arpa", ".ts.net"];

/** Whether a base URL points at this machine or a private network. A local
 *  proxy can front a paid API, so this never means "free": it only keeps a
 *  public price list from being matched to such an address. */
export function isPrivateAddress(baseURL: string): boolean {
  let host: string;
  try {
    host = new URL(baseURL.trim()).hostname;
  } catch {
    return false;
  }
  // A trailing root dot ("localhost.") names the same host.
  host = host.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  const version = isIP(host);
  if (version === 4) return PRIVATE.check(host, "ipv4");
  if (version === 6) return PRIVATE.check(host, "ipv6");
  // A name of one label (`gpu-box`) is resolved on the local network only.
  return !host.includes(".") || LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix));
}
