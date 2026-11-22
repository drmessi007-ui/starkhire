/**
 * StarkHire frontend. Visual structure derived from the author's OrbitHire UI.
 * Talks to Starknet Sepolia (Argent / Braavos via get-starknet) and the
 * StarkHire agent at AGENT_API_URL. The client confirms payout; the agent
 * only submits the report hash.
 *
 * GitHub Pages cannot inject env vars: change the constants below if you
 * self-host. Leave CONTRACT_ADDRESS empty until the contract is deployed.
 */
import { connect, disconnect } from "https://esm.sh/@starknet-io/get-starknet@4.0.8?bundle";
import { Contract, RpcProvider } from "https://esm.sh/starknet@10.8.0?bundle";

export const AGENT_API_URL = "https://starkhire.deosorno.cl";
export const CONTRACT_ADDRESS = "";
export const SEPOLIA_RPC_URL = "https://starknet-sepolia.public.blastapi.io";
export const SEPOLIA_CHAIN_ID = "0x534e5f5345504f4c4941";
export const STARKSCAN_TX = "https://sepolia.starkscan.io/tx/";
export const STARKSCAN_CONTRACT = "https://sepolia.starkscan.io/contract/";

const STATUS_NAMES = {
  0: "NONE",
  1: "OPEN",
  2: "REPORT_SUBMITTED",
  3: "RELEASED",
  4: "REFUNDED",
  5: "CANCELLED",
};

const ERC20_ABI = [
  {
    type: "interface",
    name: "IERC20",
    items: [
      {
        type: "function",
        name: "approve",
        inputs: [
          { name: "spender", type: "core::starknet::contract_address::ContractAddress" },
          { name: "amount", type: "core::integer::u256" },
        ],
        outputs: [{ type: "core::bool" }],
        state_mutability: "external",
      },
      {
        type: "function",
        name: "allowance",
        inputs: [
          { name: "owner", type: "core::starknet::contract_address::ContractAddress" },
          { name: "spender", type: "core::starknet::contract_address::ContractAddress" },
        ],
        outputs: [{ type: "core::integer::u256" }],
        state_mutability: "view",
      },
      {
        type: "function",
        name: "decimals",
        inputs: [],
        outputs: [{ type: "core::integer::u8" }],
        state_mutability: "view",
      },
      {
        type: "function",
        name: "symbol",
        inputs: [],
        outputs: [{ type: "core::felt252" }],
        state_mutability: "view",
      },
      {
        type: "function",
        name: "balance_of",
        inputs: [{ name: "account", type: "core::starknet::contract_address::ContractAddress" }],
        outputs: [{ type: "core::integer::u256" }],
        state_mutability: "view",
      },
    ],
  },
  {
    type: "impl",
    name: "ERC20Impl",
    interface_name: "IERC20",
  },
];

const HISTORY_KEY = "starkhire.history.v1";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const els = {};
let wallet = null;
let account = null;
let address = "";
let hireAbi = null;
let fee = 0n;
let tokenAddress = "";
let tokenSymbol = "TOKEN";
let tokenDecimals = 18;
let agentHealthy = false;
let pollTimer = null;
let currentRequest = null;

function $(id) {
  return document.getElementById(id);
}

function shortAddr(value) {
  const s = String(value || "");
  if (s.length < 14) return s;
  return `${s.slice(0, 8)}…${s.slice(-6)}`;
}

function toBigInt(value) {
  if (value === null || value === undefined) return 0n;
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  if (typeof value === "string") return BigInt(value);
  if (typeof value === "object" && value.low !== undefined) {
    return BigInt(value.low) + (BigInt(value.high) << 128n);
  }
  return BigInt(value);
}

function formatUnits(amount, decimals) {
  const neg = amount < 0n;
  const value = neg ? -amount : amount;
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const frac = (value % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
}

function uuidv4() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function isMainnetChain(chainId) {
  const id = String(chainId || "").toLowerCase();
  return id === "0x534e5f4d41494e" || id.includes("mainnet") || id === "sn_main";
}

function isSepoliaChain(chainId) {
  const id = String(chainId || "").toLowerCase();
  return (
    id === SEPOLIA_CHAIN_ID.toLowerCase() ||
    id === "sn_sepolia" ||
    id === "0x534e5f5345504f4c4941"
  );
}

function setStatus(text) {
  if (els.statusLabel) els.statusLabel.textContent = text;
}

function showResult(visible) {
  if (els.emptyState) els.emptyState.hidden = visible;
  if (els.resultContent) els.resultContent.hidden = !visible;
}

function setLive(text, { busy = false } = {}) {
  if (!els.progressLive) return;
  if (!text) {
    els.progressLive.hidden = true;
    els.resultProgress.hidden = true;
    return;
  }
  els.resultProgress.hidden = false;
  els.progressLive.hidden = false;
  els.progressLiveText.textContent = text;
  els.progressLive.classList.toggle("busy", busy);
}

function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveHistory(entries) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(entries.slice(0, 50)));
    els.historyStorageNote.hidden = true;
  } catch {
    els.historyStorageNote.hidden = false;
    els.historyStorageNote.textContent = "No se pudo guardar el historial en este navegador.";
  }
}

function upsertHistory(entry) {
  const all = loadHistory().filter((item) => item.requestId !== entry.requestId);
  all.unshift(entry);
  saveHistory(all);
  renderHistory();
}

function renderHistory() {
  const all = loadHistory().filter((item) => !address || item.address === address);
  if (!address) {
    els.historyWallet.textContent = "Conecta una wallet para ver su historial";
  } else {
    els.historyWallet.textContent = shortAddr(address);
  }
  if (!all.length) {
    els.historyEmpty.hidden = false;
    els.historyList.hidden = true;
    els.historyList.innerHTML = "";
    return;
  }
  els.historyEmpty.hidden = true;
  els.historyList.hidden = false;
  els.historyList.innerHTML = all
    .map((item) => {
      const href = item.txHash ? `${STARKSCAN_TX}${item.txHash}` : "#";
      return `<li><button type="button" data-id="${item.requestId}">${item.query?.slice(0, 80) || item.requestId}</button> <span>${item.status || ""}</span> ${item.txHash ? `<a href="${href}" target="_blank" rel="noopener noreferrer">tx ↗</a>` : ""}</li>`;
    })
    .join("");
}

function readChainId(walletObj) {
  return (
    walletObj?.chainId ||
    walletObj?.account?.channel?.chainId ||
    walletObj?.provider?.chainId ||
    ""
  );
}

async function loadAbi() {
  if (hireAbi) return hireAbi;
  const res = await fetch("./starkhire.abi.json");
  if (!res.ok) throw new Error("No se pudo cargar el ABI del contrato");
  hireAbi = await res.json();
  return hireAbi;
}

function provider() {
  return new RpcProvider({ nodeUrl: SEPOLIA_RPC_URL });
}

function hireContract(withAccount = false) {
  if (!CONTRACT_ADDRESS) throw new Error("El contrato aún no está desplegado");
  return new Contract({
    abi: hireAbi,
    address: CONTRACT_ADDRESS,
    providerOrAccount: withAccount ? account : provider(),
  });
}

function tokenContract(withAccount = false) {
  if (!tokenAddress) throw new Error("El contrato no ha devuelto la dirección del token");
  return new Contract({
    abi: ERC20_ABI,
    address: tokenAddress,
    providerOrAccount: withAccount ? account : provider(),
  });
}

async function checkAgent() {
  try {
    const res = await fetch(`${AGENT_API_URL}/health`, { method: "GET" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    agentHealthy = body?.ok === true;
    return body;
  } catch {
    agentHealthy = false;
    return null;
  }
}

async function refreshContractInfo() {
  els.contractAddressLabel.textContent = CONTRACT_ADDRESS || "aún no desplegado";
  if (!CONTRACT_ADDRESS) {
    els.feeLabel.textContent = "Pendiente de contrato";
    return;
  }
  await loadAbi();
  const hire = hireContract(false);
  fee = toBigInt(await hire.get_fee());
  tokenAddress = String(await hire.get_token());
  try {
    const token = tokenContract(false);
    tokenDecimals = Number(toBigInt(await token.decimals()));
    const rawSymbol = await token.symbol();
    if (typeof rawSymbol === "string" && rawSymbol.length) {
      tokenSymbol = rawSymbol;
    } else if (rawSymbol && typeof rawSymbol === "object") {
      tokenSymbol = String(rawSymbol);
    }
  } catch {
    tokenSymbol = "TOKEN";
    tokenDecimals = 18;
  }
  els.feeLabel.textContent = `${formatUnits(fee, tokenDecimals)} ${tokenSymbol}`;
}

function updatePayButton() {
  const query = els.query.value.trim();
  const ready =
    Boolean(CONTRACT_ADDRESS) &&
    Boolean(account) &&
    Boolean(address) &&
    agentHealthy &&
    fee > 0n &&
    query.length > 0;
  els.submitButton.disabled = !ready;
}

function updateNotes() {
  const parts = [];
  if (!CONTRACT_ADDRESS) {
    parts.push("El contrato de escrow aún no está desplegado en Sepolia. La dirección se publicará en el README cuando el propietario lo despliegue.");
  }
  if (!agentHealthy) {
    parts.push(`El agente en ${AGENT_API_URL} no responde todavía (el subdominio o el servicio pueden no estar instalados).`);
  }
  if (!address) {
    parts.push("Conecta Argent o Braavos en Starknet Sepolia.");
  }
  els.agentApiNote.textContent = parts.join(" ") || `Agente: ${AGENT_API_URL}. Tarifa leída del contrato.`;
}

async function connectWallet() {
  try {
    if (wallet && address) {
      try {
        await disconnect({ clearLastWallet: true });
      } catch {
        /* ignore */
      }
      wallet = null;
      account = null;
      address = "";
      els.walletButton.textContent = "Conectar wallet (Argent / Braavos)";
      els.historyWallet.textContent = "Conecta una wallet para ver su historial";
      updatePayButton();
      updateNotes();
      renderHistory();
      return;
    }
    const connected = await connect({
      modalMode: "alwaysAsk",
      modalTheme: "dark",
    });
    if (!connected) {
      setStatus("Conexión cancelada");
      return;
    }
    if (typeof connected.enable === "function") {
      await connected.enable({ starknetVersion: "v5" });
    }
    wallet = connected;
    account = connected.account || connected;
    address = connected.selectedAddress || connected.account?.address || "";
    const chainId = await Promise.resolve(readChainId(connected));
    if (isMainnetChain(chainId)) {
      wallet = null;
      account = null;
      address = "";
      setStatus("Rechazado: no uses mainnet con este prototipo");
      els.resultCopy.textContent = "StarkHire solo opera en Starknet Sepolia. Cambia la red en tu wallet e inténtalo de nuevo.";
      showResult(true);
      return;
    }
    if (chainId && !isSepoliaChain(chainId)) {
      setStatus("Cambia la wallet a Starknet Sepolia");
    }
    els.walletButton.textContent = shortAddr(address) || "Wallet conectada";
    setStatus("Wallet conectada en Sepolia");
    renderHistory();
    updatePayButton();
    updateNotes();
  } catch (error) {
    setStatus("No se pudo conectar la wallet");
    els.agentApiNote.textContent = error.message || String(error);
  }
}

async function approveAndRequest(query) {
  const requestId = uuidv4();
  if (!UUID_V4.test(requestId)) throw new Error("No se pudo generar un UUID v4");
  const hire = hireContract(true);
  const token = tokenContract(true);
  setLive("Solicitando approve del token en la wallet…", { busy: true });
  const approveTx = await token.approve(CONTRACT_ADDRESS, fee);
  const approveHash = approveTx?.transaction_hash || approveTx?.transactionHash;
  if (approveHash && provider().waitForTransaction) {
    await provider().waitForTransaction(approveHash);
  }
  setLive("Solicitando request_service (bloqueo de la tarifa)…", { busy: true });
  const reqTx = await hire.request_service(requestId, query);
  const txHash = reqTx?.transaction_hash || reqTx?.transactionHash;
  if (txHash && provider().waitForTransaction) {
    await provider().waitForTransaction(txHash);
  }
  return { requestId, txHash: txHash ? String(txHash) : "" };
}

async function notifyAgent({ requestId, query, txHash }) {
  const res = await fetch(`${AGENT_API_URL}/api/notify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      request_id: requestId,
      query,
      tx_hash: txHash || undefined,
      sender_address: address || undefined,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok && res.status !== 202) {
    throw new Error(body.error || `El agente respondió ${res.status}`);
  }
  return body;
}

async function fetchAgentResult(requestId) {
  const res = await fetch(`${AGENT_API_URL}/api/requests/${requestId}`);
  const body = await res.json().catch(() => ({}));
  return { http: res.status, body };
}

function showRequest({ requestId, txHash, report, message }) {
  showResult(true);
  els.requestId.textContent = requestId;
  if (txHash) {
    els.transactionLink.href = `${STARKSCAN_TX}${txHash}`;
    els.transactionLink.textContent = "Ver en Starkscan Sepolia ↗";
  } else {
    els.transactionLink.href = "#";
    els.transactionLink.textContent = "Transacción no disponible";
  }
  els.resultCopy.textContent = report || message || "";
}

function updateActionButtons(chainStatus) {
  els.resultActions.hidden = false;
  els.confirmButton.disabled = chainStatus !== 2;
  els.cancelButton.disabled = chainStatus !== 1;
  els.refundButton.disabled = !(chainStatus === 1 || chainStatus === 2);
}

async function refreshChainStatus(requestId) {
  if (!CONTRACT_ADDRESS) return 0;
  const hire = hireContract(false);
  const status = Number(toBigInt(await hire.get_request_status(requestId)));
  updateActionButtons(status);
  return status;
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function startPolling(requestId) {
  stopPolling();
  const tick = async () => {
    try {
      const { body } = await fetchAgentResult(requestId);
      const chainStatus = await refreshChainStatus(requestId);
      if (body?.report) {
        showRequest({
          requestId,
          txHash: currentRequest?.txHash,
          report: body.report,
          message: body.message,
        });
        setStatus("Informe listo. Confirma para pagar al agente.");
        setLive(body.message || "Informe disponible. Confirma en la wallet para liberar el pago.");
        upsertHistory({
          ...currentRequest,
          status: "REPORT_SUBMITTED",
          report: body.report,
        });
      } else if (body?.message) {
        setLive(body.message, { busy: body.status !== "failed" });
        setStatus(body.status || STATUS_NAMES[chainStatus] || "Procesando");
      }
      if (chainStatus === 3) {
        setStatus("Pago liberado al agente");
        setLive("El cliente confirmó el informe y el contrato transfirió la tarifa al agente.");
        stopPolling();
      }
      if (chainStatus === 4 || chainStatus === 5) {
        setStatus(STATUS_NAMES[chainStatus]);
        setLive(chainStatus === 4 ? "Reembolso completado." : "Solicitud cancelada y reembolsada.");
        stopPolling();
      }
      if (body?.status === "failed") stopPolling();
    } catch (error) {
      setLive(error.message || "Error al consultar el estado", { busy: false });
    }
  };
  void tick();
  pollTimer = setInterval(tick, 4000);
}

async function onSubmit() {
  const query = els.query.value.trim();
  if (!query) return;
  if (!CONTRACT_ADDRESS) return;
  if (!account) return;
  els.submitButton.disabled = true;
  showResult(true);
  els.resultCopy.textContent = "";
  try {
    setStatus("Firmas en la wallet");
    const { requestId, txHash } = await approveAndRequest(query);
    currentRequest = { requestId, txHash, query, address, status: "OPEN" };
    upsertHistory(currentRequest);
    showRequest({ requestId, txHash, message: "Tarifa bloqueada. Notificando al agente…" });
    setLive("Notificando al agente…", { busy: true });
    await notifyAgent({ requestId, query, txHash });
    setStatus("Agente notificado");
    startPolling(requestId);
  } catch (error) {
    setStatus("La consulta no se completó");
    setLive("");
    els.resultCopy.textContent = error.message || String(error);
  } finally {
    updatePayButton();
  }
}

async function onConfirm() {
  if (!currentRequest || !account) return;
  try {
    els.confirmButton.disabled = true;
    setLive("Confirmando el informe en la wallet…", { busy: true });
    const hire = hireContract(true);
    const tx = await hire.confirm_report(currentRequest.requestId);
    const txHash = tx?.transaction_hash || tx?.transactionHash;
    if (txHash && provider().waitForTransaction) {
      await provider().waitForTransaction(txHash);
    }
    setStatus("Pago enviado al agente");
    upsertHistory({ ...currentRequest, status: "RELEASED", confirmTx: txHash });
    await refreshChainStatus(currentRequest.requestId);
  } catch (error) {
    setLive(error.message || String(error));
    els.confirmButton.disabled = false;
  }
}

async function onCancel() {
  if (!currentRequest || !account) return;
  try {
    els.cancelButton.disabled = true;
    const hire = hireContract(true);
    const tx = await hire.cancel(currentRequest.requestId);
    const txHash = tx?.transaction_hash || tx?.transactionHash;
    if (txHash && provider().waitForTransaction) {
      await provider().waitForTransaction(txHash);
    }
    setStatus("Cancelada y reembolsada");
    upsertHistory({ ...currentRequest, status: "CANCELLED", cancelTx: txHash });
    stopPolling();
  } catch (error) {
    setLive(error.message || String(error));
    els.cancelButton.disabled = false;
  }
}

async function onRefund() {
  if (!currentRequest || !account) return;
  try {
    els.refundButton.disabled = true;
    const hire = hireContract(true);
    const tx = await hire.claim_refund(currentRequest.requestId);
    const txHash = tx?.transaction_hash || tx?.transactionHash;
    if (txHash && provider().waitForTransaction) {
      await provider().waitForTransaction(txHash);
    }
    setStatus("Reembolso reclamado");
    upsertHistory({ ...currentRequest, status: "REFUNDED", refundTx: txHash });
    stopPolling();
  } catch (error) {
    setLive(error.message || String(error));
    els.refundButton.disabled = false;
  }
}

function bind() {
  els.walletButton = $("wallet-button");
  els.query = $("query");
  els.charCount = $("char-count");
  els.submitButton = $("submit-button");
  els.feeLabel = $("fee-label");
  els.agentApiNote = $("agent-api-note");
  els.statusLabel = $("status-label");
  els.emptyState = $("empty-state");
  els.resultContent = $("result-content");
  els.resultCopy = $("result-copy");
  els.resultProgress = $("result-progress");
  els.progressLive = $("progress-live");
  els.progressLiveText = $("progress-live-text");
  els.resultActions = $("result-actions");
  els.confirmButton = $("confirm-button");
  els.cancelButton = $("cancel-button");
  els.refundButton = $("refund-button");
  els.requestId = $("request-id");
  els.transactionLink = $("transaction-link");
  els.historyWallet = $("history-wallet");
  els.historyStorageNote = $("history-storage-note");
  els.historyEmpty = $("history-empty");
  els.historyList = $("history-list");
  els.contractAddressLabel = $("contract-address-label");

  els.query.addEventListener("input", () => {
    els.charCount.textContent = `${els.query.value.length} / 500`;
    updatePayButton();
  });
  els.walletButton.addEventListener("click", () => void connectWallet());
  els.submitButton.addEventListener("click", () => void onSubmit());
  els.confirmButton.addEventListener("click", () => void onConfirm());
  els.cancelButton.addEventListener("click", () => void onCancel());
  els.refundButton.addEventListener("click", () => void onRefund());
  els.historyList.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-id]");
    if (!button) return;
    const entry = loadHistory().find((item) => item.requestId === button.dataset.id);
    if (!entry) return;
    currentRequest = entry;
    showRequest({
      requestId: entry.requestId,
      txHash: entry.txHash,
      report: entry.report,
      message: entry.status,
    });
    void refreshChainStatus(entry.requestId);
  });
}

async function init() {
  bind();
  renderHistory();
  updatePayButton();
  try {
    await checkAgent();
  } catch {
    agentHealthy = false;
  }
  try {
    await refreshContractInfo();
  } catch (error) {
    els.feeLabel.textContent = "No se pudo leer la tarifa";
    els.agentApiNote.textContent = error.message || String(error);
  }
  updateNotes();
  updatePayButton();
}

init();
