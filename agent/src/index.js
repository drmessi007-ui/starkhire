/**
 * StarkHire off-chain agent. HTTP API + Starknet Sepolia escrow adapter.
 * Report pipeline modules are derived from the author's OrbitHire project
 * (https://github.com/drmessi007-ui/orbithire). This process is a new
 * instance: it must not share OrbitHire's port, systemd unit, env file, or
 * NEAR keys, and it never calls confirm_report (the client does).
 */
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { createLlmProviders } from "./llm.js";
import { buildReport, UnsupportedQueryError } from "./report-pipeline.js";
import { diskStore, withCache } from "./cached-fetch.js";
import { isTransientError, MAX_REQUEST_ATTEMPTS, nextAttemptNumber, retryDelayMs } from "./retry-policy.js";
import {
  assertSepoliaOnly,
  createChain,
  isValidUuidV4,
  loadConfig as loadChainConfig,
  sha256Hex,
  sha256U256,
  STATUS,
  STATUS_NAMES,
} from "./starknet-chain.js";

const sourceDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(sourceDir, "..");
dotenv.config({ path: path.join(projectRoot, "secrets", ".env") });
dotenv.config({ path: path.join(projectRoot, ".env") });

const MAX_NOTIFICATION_BODY_BYTES = 16_384;
const MAX_NOTIFICATIONS_PER_MINUTE = 20;
const MAX_CONCURRENT_NOTIFICATIONS = 4;

export function loadHttpConfig(env = process.env) {
  const port = Number(env.SERVICE_PORT || "8797");
  const pollIntervalMs = Number(env.POLL_INTERVAL_MS || "30000");
  const frontendOrigin = env.FRONTEND_ORIGIN?.trim() || "";
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("SERVICE_PORT must be a valid TCP port");
  }
  if (port === 8787) {
    throw new Error("SERVICE_PORT 8787 is reserved for the OrbitHire agent; use 8797 or another free port");
  }
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1000) {
    throw new Error("POLL_INTERVAL_MS must be an integer of at least 1000");
  }
  if (frontendOrigin) {
    const parsed = new URL(frontendOrigin);
    const isLocalHttp =
      parsed.protocol === "http:" &&
      (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
    if ((!isLocalHttp && parsed.protocol !== "https:") || parsed.origin !== frontendOrigin) {
      throw new Error("FRONTEND_ORIGIN must be an HTTPS origin without a path (http://localhost or http://127.0.0.1 allowed for local use)");
    }
  }
  const chain = loadChainConfig(env);
  if (!chain.rpcUrl) throw new Error("Missing required environment variable STARKNET_RPC_URL");
  if (!chain.contractAddress) throw new Error("Missing required environment variable STARKHIRE_CONTRACT_ADDRESS");
  if (!chain.agentAddress) throw new Error("Missing required environment variable AGENT_ACCOUNT_ADDRESS");
  if (!chain.privateKey) throw new Error("Missing required environment variable AGENT_PRIVATE_KEY");
  return {
    ...chain,
    serviceHost: env.SERVICE_HOST || "127.0.0.1",
    servicePort: port,
    frontendOrigin,
    pollIntervalMs,
  };
}

function isValidQuery(query) {
  if (typeof query !== "string") return false;
  if (query.length < 1 || query.length > 2000) return false;
  if ([...query].length > 500) return false;
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(query)) return false;
  if (query.trim() === "") return false;
  return true;
}

function isValidNotifyPayload(payload) {
  if (!payload || typeof payload !== "object") return false;
  if (!isValidUuidV4(payload.request_id)) return false;
  if (!isValidQuery(payload.query)) return false;
  if (payload.tx_hash !== undefined && payload.tx_hash !== null) {
    if (typeof payload.tx_hash !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(payload.tx_hash)) {
      return false;
    }
  }
  if (payload.sender_address !== undefined && payload.sender_address !== null) {
    if (typeof payload.sender_address !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(payload.sender_address)) {
      return false;
    }
  }
  return true;
}

async function readJsonBody(request, maxBytes = MAX_NOTIFICATION_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
      throw new RangeError("Notification body is too large");
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return null;
  return JSON.parse(raw);
}

export function createAgent(options = {}) {
  const env = options.env || process.env;
  const config = options.config || loadHttpConfig(env);
  assertSepoliaOnly(config);
  const chain = options.chain || createChain(config);
  const dataDir = options.dataDir || path.join(projectRoot, "data");
  const resultsFile = path.join(dataDir, "results.json");

  const processingResults = new Map();
  const processing = new Set();
  const notificationsInProgress = new Set();
  let notifyWindowStartedAt = 0;
  let notifyCount = 0;
  let activeNotifications = 0;
  let server = null;

  const llmProviders = options.llm || createLlmProviders(env);
  const fetchJson =
    options.fetchJson ||
    withCache(async (url) => {
      const res = await fetch(url, { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return res.json();
    }, diskStore(path.join(dataDir, "cache")));
  const fetchText =
    options.fetchText ||
    (async (url) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return res.text();
    });

  async function loadResults() {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    try {
      const raw = await readFile(resultsFile, "utf8");
      const parsed = JSON.parse(raw);
      for (const [id, value] of Object.entries(parsed)) {
        processingResults.set(id, value);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  async function saveResult(requestId, result) {
    processingResults.set(requestId, { ...result, updated_at: new Date().toISOString() });
    const obj = Object.fromEntries(processingResults.entries());
    await writeFile(resultsFile, JSON.stringify(obj, null, 2), { mode: 0o600 });
  }

  function publicResult(result) {
    if (!result) return null;
    return {
      status: result.status,
      ...(typeof result.message === "string" ? { message: result.message } : {}),
      ...(result.status === "completed" && typeof result.report === "string"
        ? { report: result.report }
        : {}),
      ...(result.submit_tx ? { submit_tx: result.submit_tx } : {}),
    };
  }

  async function processRequest(requestId, query) {
    if (processing.has(requestId)) return;
    const previous = processingResults.get(requestId);
    if (previous?.status === "completed") return;
    if (previous?.status === "retrying" && Date.parse(previous.retry_at) > Date.now()) return;
    processing.add(requestId);
    let attemptNumber = 0;
    try {
      attemptNumber = nextAttemptNumber(previous);
      await saveResult(requestId, {
        status: "processing",
        attempts: attemptNumber,
        message: `Procesando solicitud (intento ${attemptNumber}/${MAX_REQUEST_ATTEMPTS}).`,
      });
      await chain.assertQueryMatchesOnChain(requestId, query);
      const { report } = await buildReport(query, {
        fetchJson,
        fetchText,
        llm: llmProviders,
        log: (meta) => console.log(`Report pipeline: ${JSON.stringify(meta)}`),
      });
      const reportHash = sha256U256(report);
      await saveResult(requestId, {
        status: "submitting",
        attempts: attemptNumber,
        report,
        report_hash: "0x" + reportHash.toString(16),
        message: "Informe listo; enviando el hash al contrato.",
      });
      const submitted = await chain.submitReport(requestId, reportHash);
      await saveResult(requestId, {
        status: "completed",
        attempts: attemptNumber,
        report,
        report_hash: "0x" + reportHash.toString(16),
        submit_tx: submitted.transactionHash,
        message:
          "Informe enviado on-chain. El cliente debe confirmar en la wallet para liberar el pago al agente.",
      });
    } catch (error) {
      if (error instanceof UnsupportedQueryError) {
        await saveResult(requestId, {
          status: "failed",
          attempts: attemptNumber,
          message: error.message,
        });
        return;
      }
      if (isTransientError(error) && attemptNumber < MAX_REQUEST_ATTEMPTS) {
        const delay = retryDelayMs(attemptNumber);
        await saveResult(requestId, {
          status: "retrying",
          attempts: attemptNumber,
          retry_at: new Date(Date.now() + delay).toISOString(),
          message: `Error transitorio; reintento en ${Math.round(delay / 1000)} s.`,
        });
        setTimeout(() => {
          void processRequest(requestId, query).catch((err) =>
            console.error(`Retry failed for ${requestId}: ${err.message}`),
          );
        }, delay);
        return;
      }
      await saveResult(requestId, {
        status: "failed",
        attempts: attemptNumber,
        message: error.message || "No se pudo procesar la solicitud.",
      });
      console.error(`Request ${requestId} failed: ${error.message}`);
    } finally {
      processing.delete(requestId);
    }
  }

  async function handleNotify(request, response) {
    const origin = request.headers.origin;
    if (origin !== config.frontendOrigin) {
      response.writeHead(403, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Origin not allowed" }));
      return;
    }
    if (!/^application\/json(?:\s*;|$)/iu.test(request.headers["content-type"] || "")) {
      response.writeHead(415, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Content-Type must be application/json" }));
      return;
    }
    const contentLength = Number(request.headers["content-length"] || 0);
    if (contentLength > MAX_NOTIFICATION_BODY_BYTES) {
      request.resume();
      response.writeHead(413, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Notification body is too large" }));
      return;
    }
    if (Date.now() - notifyWindowStartedAt >= 60_000) {
      notifyWindowStartedAt = Date.now();
      notifyCount = 0;
    }
    if (notifyCount >= MAX_NOTIFICATIONS_PER_MINUTE || activeNotifications >= MAX_CONCURRENT_NOTIFICATIONS) {
      response.writeHead(429, { "content-type": "application/json", "retry-after": "60" });
      response.end(JSON.stringify({ error: "Notification rate limit exceeded" }));
      return;
    }

    let payload;
    try {
      payload = await readJsonBody(request);
    } catch (error) {
      response.writeHead(error instanceof RangeError ? 413 : 400, { "content-type": "application/json" });
      response.end(JSON.stringify({
        error: error instanceof RangeError ? error.message : "Invalid JSON",
      }));
      return;
    }
    if (!isValidNotifyPayload(payload)) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Invalid notification" }));
      return;
    }
    const requestId = payload.request_id;
    const query = payload.query;
    if (notificationsInProgress.has(requestId) || processing.has(requestId)) {
      response.writeHead(202, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "processing" }));
      return;
    }
    const existing = processingResults.get(requestId);
    if (existing && existing.status === "completed") {
      response.writeHead(202, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "completed" }));
      return;
    }

    notifyCount += 1;
    activeNotifications += 1;
    notificationsInProgress.add(requestId);
    try {
      await chain.assertQueryMatchesOnChain(requestId, query);
      await saveResult(requestId, {
        status: "queued",
        query_sha256: sha256Hex(query),
        tx_hash: payload.tx_hash || null,
        sender_address: payload.sender_address || null,
        message: "Notificación verificada on-chain; en cola.",
      });
      console.info(`Accepted verified notification for request ${requestId}.`);
      response.writeHead(202, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "queued" }));
      setImmediate(() => {
        void processRequest(requestId, query).catch((error) =>
          console.error(`Unable to process notified request ${requestId}: ${error.message}`),
        );
      });
    } catch (error) {
      const transient = isTransientError(error);
      console.warn(
        `${transient ? "Temporary verification failure" : "Rejected notification"} for request ${requestId}: ${error.message}`,
      );
      response.writeHead(transient ? 503 : 422, {
        "content-type": "application/json",
        ...(transient ? { "retry-after": "10" } : {}),
      });
      response.end(
        JSON.stringify({
          error: transient
            ? "Request verification is temporarily unavailable"
            : "Notification could not be verified on-chain",
        }),
      );
    } finally {
      notificationsInProgress.delete(requestId);
      activeNotifications -= 1;
    }
  }

  const httpServer = createServer(async (request, response) => {
    const origin = request.headers.origin;
    const allowedOrigin = typeof origin === "string" && origin === config.frontendOrigin;
    if (allowedOrigin) {
      response.setHeader("Access-Control-Allow-Origin", config.frontendOrigin);
      response.setHeader("Vary", "Origin");
      response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      response.setHeader("Access-Control-Allow-Headers", "Content-Type");
      response.setHeader("Access-Control-Max-Age", "600");
    }
    response.setHeader("Cache-Control", "no-store");
    if (request.method === "OPTIONS") {
      response.writeHead(allowedOrigin ? 204 : 403);
      response.end();
      return;
    }
    if (request.method === "POST" && request.url === "/api/notify") {
      await handleNotify(request, response);
      return;
    }
    if (request.method !== "GET") {
      response.writeHead(405, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        ok: true,
        network: config.network,
        service: "starkhire-agent",
      }));
      return;
    }
    const resultMatch = request.url?.match(
      /^\/api\/requests\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u,
    );
    if (!resultMatch) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Not found" }));
      return;
    }
    const result = processingResults.get(resultMatch[1]);
    if (!result) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "waiting_for_event" }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(publicResult(result)));
  });

  async function start() {
    await loadResults();
    const onChainAgent = await chain.getAgent();
    // Compare without throwing the private key. Warn if the configured
    // account does not match the contract's authorized agent.
    const configured = String(config.agentAddress || "").toLowerCase().replace(/^0x0+/, "0x");
    const onChain = String(onChainAgent || "").toLowerCase().replace(/^0x0+/, "0x");
    if (configured && onChain && configured !== onChain) {
      throw new Error("AGENT_ACCOUNT_ADDRESS does not match the agent stored in the contract");
    }
    const fee = await chain.getFee();
    if (fee <= 0n) throw new Error("Contract get_fee returned a non-positive fee");
    await new Promise((resolve, reject) => {
      httpServer.listen(config.servicePort, config.serviceHost, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    server = httpServer;
    console.log(`StarkHire agent API listening on ${config.serviceHost}:${config.servicePort}`);
    console.log(`Network ${config.network}; agent submits report hashes only (client confirms payout).`);
    if (!config.frontendOrigin) {
      console.warn("FRONTEND_ORIGIN is unset; browser CORS requests will be rejected.");
    }
  }

  async function stop() {
    if (!server) return;
    await new Promise((resolve) => server.close(resolve));
    server = null;
  }

  return {
    config,
    chain,
    processingResults,
    processRequest,
    start,
    stop,
    server: httpServer,
    loadResults,
    saveResult,
    isValidNotifyPayload,
    isValidQuery,
  };
}

export { isValidNotifyPayload, isValidQuery, STATUS, STATUS_NAMES, sha256Hex, sha256U256 };

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const agent = createAgent();
  agent.start().catch((error) => {
    console.error(`Agent startup failed: ${error.message}`);
    process.exitCode = 1;
  });
}
