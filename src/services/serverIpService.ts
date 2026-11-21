import axios from "axios";
import { isIP } from "node:net";

const discoveryClient = axios.create({ timeout: 5000, family: 4 });
const CACHE_MS = 5 * 60 * 1000;
let cached: { ips: string[]; expiresAt: number } | undefined;
let pending: Promise<string[]> | undefined;

/** Use configured egress addresses for NAT gateways or deployments with multiple workers. */
export async function getServerIps(): Promise<string[]> {
  const configured = process.env.EXCHANGE_OUTBOUND_IPS?.trim();
  if (configured) {
    const ips = [...new Set(configured.split(/[\s,]+/).filter(Boolean))];
    if (!ips.length || ips.some(ip => !isIP(ip))) {
      throw new Error("EXCHANGE_OUTBOUND_IPS must contain IP addresses only");
    }
    return ips;
  }

  if (cached && cached.expiresAt > Date.now()) return cached.ips;
  if (!pending) {
    pending = discoveryClient.get<string>("https://api.ipify.org", {
      responseType: "text",
      maxRedirects: 0,
      maxContentLength: 256,
    }).then(({ data }) => {
      const ip = typeof data === "string" ? data.trim() : "";
      if (isIP(ip) !== 4) throw new Error("Could not discover the server's outbound IPv4 address");
      const ips = [ip];
      cached = { ips, expiresAt: Date.now() + CACHE_MS };
      return ips;
    }).finally(() => { pending = undefined; });
  }
  return pending;
}
