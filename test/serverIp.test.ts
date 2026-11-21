import test from "node:test";
import assert from "node:assert/strict";
import axios from "axios";
import express from "express";
import cookieParser from "cookie-parser";
import type { AddressInfo } from "node:net";

test("public exchange IP endpoint uses configured egress or cached outbound discovery", async (t) => {
  const originalAdapter = axios.defaults.adapter;
  const originalIps = process.env.EXCHANGE_OUTBOUND_IPS;
  let requests = 0;
  let fail = false;
  let discoveredIp = "198.51.100.7";
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  axios.defaults.adapter = async (config) => {
    requests++;
    assert.equal(config.url, "https://api.ipify.org");
    assert.equal(config.family, 4);
    assert.equal(config.timeout, 5000);
    if (fail) throw new Error("Discovery unavailable");
    return { data: discoveredIp, status: 200, statusText: "OK", headers: {}, config };
  };
  t.after(() => {
    axios.defaults.adapter = originalAdapter;
    if (originalIps === undefined) delete process.env.EXCHANGE_OUTBOUND_IPS;
    else process.env.EXCHANGE_OUTBOUND_IPS = originalIps;
  });

  const { default: router } = await import("../src/routes/exchangeRoutes.js");
  const app = express();
  app.use(cookieParser());
  app.use("/api/exchanges", router);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/exchanges/server-ip`;

  await t.test("other exchange endpoints still require authentication", async () => {
    for (const path of ["", "/connections"]) {
      const response = await fetch(url.replace("/server-ip", path));
      assert.equal(response.status, 401);
    }
    const response = await fetch(url.replace("/server-ip", "/connect"), { method: "POST" });
    assert.equal(response.status, 401);
  });

  await t.test("returns all unique configured IPs without authentication or a discovery request", async () => {
    process.env.EXCHANGE_OUTBOUND_IPS = "198.51.100.1, 203.0.113.2 198.51.100.1";
    const response = await fetch(url, { headers: { "X-Forwarded-For": "192.0.2.99" } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { success: true, ips: ["198.51.100.1", "203.0.113.2"] });
    assert.equal(requests, 0);
  });

  await t.test("invalid configuration fails instead of showing a misleading fallback", async () => {
    process.env.EXCHANGE_OUTBOUND_IPS = "https://scopytrade.com";
    const response = await fetch(url);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).success, false);
    assert.equal(requests, 0);
  });

  await t.test("discovers and caches the server IPv4 instead of the request IP", async () => {
    delete process.env.EXCHANGE_OUTBOUND_IPS;
    const responses = await Promise.all([fetch(url), fetch(url)]);
    for (const response of responses) {
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { success: true, ips: ["198.51.100.7"] });
    }
    assert.equal(requests, 1);
  });

  await t.test("expired discovery fails cleanly and can be retried", async () => {
    now += 6 * 60 * 1000;
    fail = true;
    const response = await fetch(url);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).success, false);
    fail = false;
    const retry = await fetch(url);
    assert.equal(retry.status, 200);
    assert.equal(requests, 3);
  });

  await t.test("rejects malformed discovery results", async () => {
    now += 6 * 60 * 1000;
    discoveredIp = "not-an-ip";
    const response = await fetch(url);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).success, false);
  });
});
