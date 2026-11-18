import { afterEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import axios from "axios";
import {
  getOutboundPublicIp,
  getPublicIpHandler,
  clearPublicIpCache,
} from "./publicIpService.js";

describe("publicIpService", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    mock.restoreAll();
    process.env = { ...originalEnv };
    clearPublicIpCache();
  });

  it("returns SERVER_OUTBOUND_IP when explicitly configured with a valid IP", async () => {
    process.env.SERVER_OUTBOUND_IP = "198.51.100.42";
    const ip = await getOutboundPublicIp();
    assert.equal(ip, "198.51.100.42");
  });

  it("ignores invalid SERVER_OUTBOUND_IP and queries outbound IP provider", async () => {
    process.env.SERVER_OUTBOUND_IP = "not-an-ip";
    mock.method(axios, "get", async (url: string) => {
      if (url.includes("ipify")) {
        return { data: { ip: "203.0.113.195" } };
      }
      throw new Error("unexpected URL");
    });

    const ip = await getOutboundPublicIp();
    assert.equal(ip, "203.0.113.195");
  });

  it("caches the resolved outbound IP within TTL", async () => {
    delete process.env.SERVER_OUTBOUND_IP;
    let callCount = 0;
    mock.method(axios, "get", async () => {
      callCount++;
      return { data: { ip: "203.0.113.50" } };
    });

    const first = await getOutboundPublicIp();
    const second = await getOutboundPublicIp();

    assert.equal(first, "203.0.113.50");
    assert.equal(second, "203.0.113.50");
    assert.equal(callCount, 1);
  });

  it("falls back to secondary provider if first provider fails", async () => {
    delete process.env.SERVER_OUTBOUND_IP;
    mock.method(axios, "get", async (url: string) => {
      if (url.includes("ipify")) {
        throw new Error("ipify timeout");
      }
      if (url.includes("ifconfig")) {
        return { data: { ip_addr: "198.51.100.99" } };
      }
      throw new Error("not found");
    });

    const ip = await getOutboundPublicIp();
    assert.equal(ip, "198.51.100.99");
  });

  it("throws safe error if all external IP echo providers fail", async () => {
    delete process.env.SERVER_OUTBOUND_IP;
    mock.method(axios, "get", async () => {
      throw new Error("network down");
    });

    await assert.rejects(
      () => getOutboundPublicIp(),
      /Outbound public IP could not be established/,
    );
  });

  it("getPublicIpHandler returns 200 with minimal payload on success", async () => {
    process.env.SERVER_OUTBOUND_IP = "192.0.2.1";
    let status = 0;
    let body: any = null;

    const res: any = {
      status(s: number) {
        status = s;
        return this;
      },
      json(b: any) {
        body = b;
        return this;
      },
    };

    await getPublicIpHandler({} as any, res);
    assert.equal(status, 200);
    assert.deepEqual(body, { success: true, ip: "192.0.2.1" });
  });

  it("getPublicIpHandler returns 503 when IP cannot be established", async () => {
    delete process.env.SERVER_OUTBOUND_IP;
    mock.method(axios, "get", async () => {
      throw new Error("network failed");
    });

    let status = 0;
    let body: any = null;

    const res: any = {
      status(s: number) {
        status = s;
        return this;
      },
      json(b: any) {
        body = b;
        return this;
      },
    };

    await getPublicIpHandler({} as any, res);
    assert.equal(status, 503);
    assert.equal(body.success, false);
    assert.match(body.message, /could not be established/);
  });
});