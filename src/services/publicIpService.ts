import axios from "axios";
import net from "net";
import { Request, Response } from "express";

interface CachedIp {
  ip: string;
  cachedAt: number;
}

let cachedIp: CachedIp | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export function clearPublicIpCache(): void {
  cachedIp = null;
}

/**
 * Retrieves the server's actual outbound public IP address.
 * Priority:
 * 1. SERVER_OUTBOUND_IP environment variable (if explicitly set and valid).
 * 2. In-memory cache (within 5 minutes).
 * 3. External IP echo services (api.ipify.org, ifconfig.me, myip.com).
 */
export async function getOutboundPublicIp(): Promise<string> {
  const envIp = process.env.SERVER_OUTBOUND_IP?.trim();
  if (envIp && net.isIP(envIp)) {
    return envIp;
  }

  const now = Date.now();
  if (cachedIp && now - cachedIp.cachedAt < CACHE_TTL_MS) {
    return cachedIp.ip;
  }

  const providers = [
    {
      url: "https://api.ipify.org?format=json",
      extract: (data: any) => data?.ip,
    },
    {
      url: "https://ifconfig.me/all.json",
      extract: (data: any) => data?.ip_addr,
    },
    {
      url: "https://api.myip.com",
      extract: (data: any) => data?.ip,
    },
  ];

  for (const provider of providers) {
    try {
      const res = await axios.get(provider.url, {
        timeout: 3500,
        headers: { Accept: "application/json" },
      });
      const ip = String(provider.extract(res.data) ?? "").trim();
      if (ip && net.isIP(ip)) {
        cachedIp = { ip, cachedAt: now };
        return ip;
      }
    } catch {
      // Continue to next provider on network error or timeout
    }
  }

  throw new Error("Outbound public IP could not be established.");
}

/**
 * Controller handler returning minimal safe JSON for frontend display.
 */
export async function getPublicIpHandler(_req: Request, res: Response) {
  try {
    const ip = await getOutboundPublicIp();
    return res.status(200).json({
      success: true,
      ip,
    });
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : "Outbound public IP could not be established.";
    return res.status(503).json({
      success: false,
      message,
    });
  }
}