import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAgent, loadHttpConfig } from "../src/index.js";
import { sha256U256, STATUS } from "../src/starknet-chain.js";

const UUID = "550e8400-e29b-41d4-a716-446655440000";

describe("loadHttpConfig", () => {
  const base = {
    STARKNET_NETWORK: "sepolia",
    STARKNET_RPC_URL: "https://starknet-sepolia.public.blastapi.io",
    STARKHIRE_CONTRACT_ADDRESS: "0x1",
    AGENT_ACCOUNT_ADDRESS: "0x2",
    AGENT_PRIVATE_KEY: "0x3",
    FRONTEND_ORIGIN: "https://drmessi007-ui.github.io",
  };

  it("defaults the port to 8797 and rejects 8787", () => {
    const cfg = loadHttpConfig(base);
    assert.equal(cfg.servicePort, 8797);
    assert.throws(() => loadHttpConfig({ ...base, SERVICE_PORT: "8787" }), /8787 is reserved/);
  });

  it("accepts the GitHub Pages HTTPS origin and localhost HTTP", () => {
    assert.equal(loadHttpConfig(base).frontendOrigin, "https://drmessi007-ui.github.io");
    assert.equal(
      loadHttpConfig({ ...base, FRONTEND_ORIGIN: "http://localhost:5500" }).frontendOrigin,
      "http://localhost:5500",
    );
    assert.throws(
      () => loadHttpConfig({ ...base, FRONTEND_ORIGIN: "https://example.com/path" }),
      /without a path/,
    );
  });

  it("requires chain env vars", () => {
    assert.throws(() => loadHttpConfig({ ...base, AGENT_PRIVATE_KEY: "" }), /AGENT_PRIVATE_KEY/);
  });
});

describe("HTTP API with a mocked chain", () => {
  const query = "kp index tonight";
  let dataDir;
  let agent;
  let baseUrl;
  const origin = "https://drmessi007-ui.github.io";

  function mockChain() {
    const state = { status: STATUS.OPEN, commitment: sha256U256(query), agent: "0x2", fee: 1n };
    return {
      state,
      getAgent: async () => state.agent,
      getFee: async () => state.fee,
      assertQueryMatchesOnChain: async (requestId, q) => {
        if (requestId !== UUID) throw new Error("query does not match the on-chain request commitment");
        if (state.status !== STATUS.OPEN) throw new Error("request is not open");
        if (sha256U256(q) !== state.commitment) throw new Error("query does not match the on-chain request commitment");
      },
      submitReport: async (requestId, reportHash) => {
        state.status = STATUS.REPORT_SUBMITTED;
        state.lastHash = reportHash;
        return { transactionHash: "0xfeed", reportHash };
      },
    };
  }

  function request(method, urlPath, { headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request(
        baseUrl + urlPath,
        { method, headers },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let json = null;
            try { json = text ? JSON.parse(text) : null; } catch { json = text; }
            resolve({ status: res.statusCode, json, headers: res.headers });
          });
        },
      );
      req.on("error", reject);
      if (body) req.write(body);
      req.end();
    });
  }

  before(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "starkhire-agent-"));
    const chain = mockChain();
    agent = createAgent({
      env: {
        STARKNET_NETWORK: "sepolia",
        STARKNET_RPC_URL: "https://starknet-sepolia.public.blastapi.io",
        STARKHIRE_CONTRACT_ADDRESS: "0x1",
        AGENT_ACCOUNT_ADDRESS: "0x2",
        AGENT_PRIVATE_KEY: "0x3",
        SERVICE_HOST: "127.0.0.1",
        SERVICE_PORT: "8798",
        FRONTEND_ORIGIN: origin,
      },
      chain,
      dataDir,
      fetchJson: async () => [{ time_tag: "2026-11-22T00:00:00Z", kp_index: 3.0 }],
      fetchText: async () => "",
      llm: [],
    });
    await agent.start();
    baseUrl = "http://127.0.0.1:8798";
  });

  after(async () => {
    if (agent) await agent.stop();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  it("serves /health without leaking keys", async () => {
    const res = await request("GET", "/health");
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.network, "sepolia");
    assert.equal(res.json.service, "starkhire-agent");
    assert.equal("private_key" in res.json, false);
  });

  it("rejects notify from a foreign origin", async () => {
    const res = await request("POST", "/api/notify", {
      headers: { origin: "https://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ request_id: UUID, query }),
    });
    assert.equal(res.status, 403);
  });

  it("accepts a verified notify and later returns the report", async () => {
    const res = await request("POST", "/api/notify", {
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ request_id: UUID, query, tx_hash: "0xabc", sender_address: "0xdef" }),
    });
    assert.equal(res.status, 202);
    assert.equal(res.json.status, "queued");

    let latest;
    for (let i = 0; i < 40; i += 1) {
      latest = await request("GET", `/api/requests/${UUID}`, { headers: { origin } });
      if (latest.json?.status === "completed" || latest.json?.status === "failed") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(latest.status, 200);
    assert.equal(latest.json.status, "completed");
    assert.equal(typeof latest.json.report, "string");
    assert.ok(latest.json.report.length > 0);
    assert.equal(latest.json.submit_tx, "0xfeed");
  });

  it("rejects a notify whose query does not match the chain", async () => {
    const other = "661e8400-e29b-41d4-a716-446655440000";
    const res = await request("POST", "/api/notify", {
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ request_id: other, query: "a different query" }),
    });
    assert.equal(res.status, 422);
  });
});
