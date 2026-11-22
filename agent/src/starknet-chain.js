/**
 * Starknet adapter for StarkHire. Replaces the NEAR chain layer from OrbitHire.
 * Views and mutations go through an injectable provider/account so tests can
 * run without a live network or a real private key.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Contract, RpcProvider, Account, uint256 } from "starknet";

const ABI = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "starkhire.abi.json"), "utf8"),
);

export const STATUS = {
  NONE: 0,
  OPEN: 1,
  REPORT_SUBMITTED: 2,
  RELEASED: 3,
  REFUNDED: 4,
  CANCELLED: 5,
};

export const STATUS_NAMES = Object.fromEntries(
  Object.entries(STATUS).map(([k, v]) => [v, k]),
);

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isValidUuidV4(value) {
  return typeof value === "string" && UUID_V4.test(value);
}

export function sha256Hex(text) {
  return createHash("sha256").update(String(text), "utf8").digest("hex");
}

export function sha256U256(text) {
  return BigInt("0x" + sha256Hex(text));
}

export function requestKeyFromId(requestId) {
  if (!isValidUuidV4(requestId)) {
    throw new Error("invalid request id");
  }
  const digest = createHash("sha256").update(requestId, "utf8").digest();
  const mask = (1n << 251n) - 1n;
  return BigInt("0x" + digest.toString("hex")) & mask;
}

export function toBigInt(value) {
  if (value === null || value === undefined) return 0n;
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  if (typeof value === "string") {
    const s = value.trim();
    if (s === "") return 0n;
    return s.startsWith("0x") || s.startsWith("0X") ? BigInt(s) : BigInt(s);
  }
  if (typeof value === "object") {
    if (value.low !== undefined && value.high !== undefined) {
      return uint256.uint256ToBN(value);
    }
    if (Array.isArray(value) && value.length === 2) {
      return uint256.uint256ToBN({ low: value[0], high: value[1] });
    }
  }
  return BigInt(value);
}

function normalizeAddress(addr) {
  if (addr === null || addr === undefined || addr === "") return "";
  let hex = String(addr).toLowerCase();
  if (!hex.startsWith("0x")) hex = "0x" + hex;
  const body = hex.slice(2).replace(/^0+/, "") || "0";
  return "0x" + body;
}

export function addressesEqual(a, b) {
  return normalizeAddress(a) === normalizeAddress(b);
}

function isMainnetNetwork(network, rpcUrl) {
  const n = String(network || "").toLowerCase();
  const url = String(rpcUrl || "").toLowerCase();
  if (n === "mainnet" || n === "starknet-mainnet" || n.includes("mainnet")) return true;
  if (url.includes("mainnet") && !url.includes("sepolia") && !url.includes("testnet")) {
    return true;
  }
  return false;
}

export function assertSepoliaOnly({ network, rpcUrl }) {
  if (isMainnetNetwork(network, rpcUrl)) {
    throw new Error("StarkHire agent refuses to start on Starknet mainnet");
  }
  const n = String(network || "").toLowerCase();
  if (n && n !== "sepolia" && n !== "starknet-sepolia" && n !== "testnet") {
    throw new Error(`unsupported STARKNET_NETWORK: ${network} (use sepolia)`);
  }
}

export function loadConfig(env = process.env) {
  const network = (env.STARKNET_NETWORK || "sepolia").trim();
  const rpcUrl = (env.STARKNET_RPC_URL || "").trim();
  const contractAddress = (env.STARKHIRE_CONTRACT_ADDRESS || "").trim();
  const agentAddress = (env.AGENT_ACCOUNT_ADDRESS || "").trim();
  const privateKey = (env.AGENT_PRIVATE_KEY || "").trim();
  assertSepoliaOnly({ network, rpcUrl });
  return { network, rpcUrl, contractAddress, agentAddress, privateKey };
}

export function createDefaultProvider(rpcUrl) {
  if (!rpcUrl) throw new Error("STARKNET_RPC_URL is required");
  return new RpcProvider({ nodeUrl: rpcUrl });
}

export function createAccount(provider, address, privateKey) {
  if (!address || !privateKey) {
    throw new Error("AGENT_ACCOUNT_ADDRESS and AGENT_PRIVATE_KEY are required to submit reports");
  }
  return new Account({ provider, address, signer: privateKey });
}

export function createHireContract({ provider, account, contractAddress, abi = ABI }) {
  if (!contractAddress) throw new Error("STARKHIRE_CONTRACT_ADDRESS is required");
  const contract = new Contract({
    abi,
    address: contractAddress,
    providerOrAccount: account || provider,
  });
  return contract;
}

/**
 * High-level chain helpers. `deps` may inject { provider, account, contract }
 * for tests. When omitted, they are created from config.
 */
export function createChain(config, deps = {}) {
  const cfg = { ...config };
  let provider = deps.provider || null;
  let account = deps.account || null;
  let contract = deps.contract || null;

  function getProvider() {
    if (!provider) provider = createDefaultProvider(cfg.rpcUrl);
    return provider;
  }

  function getAccount() {
    if (!account) account = createAccount(getProvider(), cfg.agentAddress, cfg.privateKey);
    return account;
  }

  function getContract({ withAccount } = { withAccount: false }) {
    if (contract) return contract;
    return createHireContract({
      provider: getProvider(),
      account: withAccount ? getAccount() : undefined,
      contractAddress: cfg.contractAddress,
    });
  }

  async function getFee() {
    const v = await getContract().get_fee();
    return toBigInt(v);
  }

  async function getToken() {
    return normalizeAddress(await getContract().get_token());
  }

  async function getAgent() {
    return normalizeAddress(await getContract().get_agent());
  }

  async function getRequestStatus(requestId) {
    const v = await getContract().get_request_status(requestId);
    return Number(toBigInt(v));
  }

  async function getRequestCommitment(requestId) {
    const v = await getContract().get_request_commitment(requestId);
    return toBigInt(v);
  }

  async function getReportHash(requestId) {
    const v = await getContract().get_report_hash(requestId);
    return toBigInt(v);
  }

  async function getRefundAfter(requestId) {
    const v = await getContract().get_refund_after(requestId);
    return Number(toBigInt(v));
  }

  async function assertQueryMatchesOnChain(requestId, query) {
    const status = await getRequestStatus(requestId);
    if (status !== STATUS.OPEN) {
      throw new Error(
        `request is not open (status=${STATUS_NAMES[status] || status})`,
      );
    }
    const onChain = await getRequestCommitment(requestId);
    const local = sha256U256(query);
    if (onChain !== local) {
      throw new Error("query does not match the on-chain request commitment");
    }
  }

  async function submitReport(requestId, reportHash) {
    const hash = typeof reportHash === "bigint" ? reportHash : sha256U256(String(reportHash));
    const c = getContract({ withAccount: true });
    const tx = await c.submit_report(requestId, hash);
    const hashTx = tx?.transaction_hash || tx?.transactionHash || tx;
    if (deps.waitForTransaction) {
      await deps.waitForTransaction(hashTx);
    } else if (typeof getProvider().waitForTransaction === "function") {
      await getProvider().waitForTransaction(hashTx);
    }
    return { transactionHash: String(hashTx), reportHash: hash };
  }

  return {
    config: cfg,
    getProvider,
    getAccount,
    getContract,
    getFee,
    getToken,
    getAgent,
    getRequestStatus,
    getRequestCommitment,
    getReportHash,
    getRefundAfter,
    assertQueryMatchesOnChain,
    submitReport,
    STATUS,
  };
}

export { ABI };
