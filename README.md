# StarkHire

StarkHire is a Starknet Sepolia prototype: a client pays a fixed ERC-20 fee into a Cairo escrow, an off-chain agent builds a space briefing (NOAA, CelesTrak, and related open data), the agent submits the report hash, and **the client confirms** to release the fee to the agent. If the client cancels while the request is still open, or if the refund window elapses, the fee can be returned to the client.

This repository is a new project. It is derived from the author's own [OrbitHire](https://github.com/drmessi007-ui/orbithire) (a NEAR testnet prototype). OrbitHire remains a separate contest entry and is not modified by this work. The off-chain report pipeline in `agent/src/` (report-pipeline, space-data, llm, and related modules) was copied from that project and marked as such. The chain layer, contract, frontend wallet integration, process, port, and deployment unit are new.

**Status (facts at first publication):** the Cairo contract compiles and its `snforge` tests pass locally. The agent unit tests pass locally with a mocked Starknet layer. The contract has **not** been deployed to Sepolia. The agent is **not** installed on the server. The planned API host `https://starkhire.deosorno.cl` did not have a public DNS record when this repository was created. No contract address is published here until the owner deploys one.

This prototype is restricted to **Starknet Sepolia**. The agent refuses to start on mainnet. Do not use a mainnet wallet or key with it.

## Repository layout

- `src/starkhire.cairo` — escrow contract (request with payment, agent `submit_report`, client `confirm_report`, `cancel` while open, `claim_refund` after the timeout).
- `src/mock_erc20.cairo` — OpenZeppelin ERC-20 used only in tests.
- `tests/test_starkhire.cairo` — Starknet Foundry tests.
- `agent/` — off-chain agent (port **8797** by default; 8787 is refused so it cannot collide with the OrbitHire agent).
- `frontend/` — static UI (Argent / Braavos via get-starknet). `AGENT_API_URL` is `https://starkhire.deosorno.cl`. `CONTRACT_ADDRESS` in `frontend/app.js` is empty until a Sepolia deployment exists.
- `deploy/` — systemd unit, Nginx server block, env template, and a step-by-step install checklist. These are files in the repo only; they are not applied to any server by publishing this repository.

## Tooling used to develop and test this tree

On the development box these versions were used:

- Scarb `2.21.0`
- Starknet Foundry (`snforge` / `sncast`) `0.64.1`
- Cairo `2.21.0` (via Scarb)
- Node.js `v24` for the agent tests (the service unit template expects Node 22+)
- `starknet.js` `10.8.0` in the agent

Pin versions for this repo in `.tool-versions`.

```bash
# after installing Scarb and Starknet Foundry
snforge test
```

```bash
cd agent
npm ci
npm test
```

`agent/test/live-apis.test.js` calls live NOAA / CelesTrak endpoints and may fail offline; the other agent tests do not require those services.

## Contract behaviour

Constructor: `owner`, `agent`, ERC-20 `token`, `fee`, `refund_window_seconds`, `rate_limit_seconds`.

- `request_service(request_id, query)` — the client must `approve` the fee to the contract first. The request id is a lowercase UUID v4. The on-chain commitment is `sha256(query)`.
- `submit_report(request_id, report_hash)` — only the configured agent, and only while the request is open.
- `confirm_report(request_id)` — only the original client, after a report hash has been submitted; transfers the fee to the agent.
- `cancel(request_id)` — only the client, and only while the request is still open (before a report is submitted); refunds the fee.
- `claim_refund(request_id)` — after the refund window, from Open or ReportSubmitted; refunds the fee to the client.
- Views include `get_fee`, `get_token`, `get_agent`, `get_request_status`, `get_request_commitment`, `get_report_hash`, `get_refund_after`.
- Events: `RequestCreated`, `ReportSubmitted`, `ReportConfirmed`, `Refunded`, `Cancelled`.

Statuses: `NONE=0`, `OPEN=1`, `REPORT_SUBMITTED=2`, `RELEASED=3`, `REFUNDED=4`, `CANCELLED=5`.

## Agent

Configuration is documented in `agent/.env.example` (`STARKNET_RPC_URL`, `STARKHIRE_CONTRACT_ADDRESS`, `AGENT_ACCOUNT_ADDRESS`, `AGENT_PRIVATE_KEY`, `SERVICE_PORT`, `FRONTEND_ORIGIN`, …). Never commit a real `.env` or private key.

HTTP API (same shapes as the OrbitHire agent, on a new process):

- `GET /health` → `{"ok":true,"network":"sepolia","service":"starkhire-agent"}`
- `POST /api/notify` — JSON `{ "request_id", "query", "tx_hash?", "sender_address?" }`. CORS and origin checks use `FRONTEND_ORIGIN`. The query is not trusted from the browser: the agent checks that the request is `OPEN` and that `sha256(query)` matches `get_request_commitment`.
- `GET /api/requests/{uuid}` — public processing status and, when completed, the report text.

The agent calls `submit_report` only. It never calls `confirm_report`.

Default listen address: `127.0.0.1:8797`.

## Frontend

Static files in `frontend/`. Connect a Starknet wallet (Argent or Braavos) on **Sepolia**, approve the fee token, send `request_service`, notify the agent, then **Confirmar y pagar al agente** (or cancel / claim a timeout refund).

The payment button stays disabled until all of the following are true: a contract address is configured, a Sepolia wallet is connected, the agent `/health` endpoint responds, and the query is non-empty.

## Deployment

See [`deploy/INSTALL.md`](deploy/INSTALL.md). Summary: create Sepolia wallets and fund them, deploy the contract, add DNS for `starkhire.deosorno.cl`, then — only with owner approval — install `starkhire-agent.service` and the Nginx site from `deploy/`, without changing any OrbitHire unit, env, or vhost.

GitHub Pages: the workflow file lives at [`deploy/github-pages.yml`](deploy/github-pages.yml) (it does not use repository secrets). The `gh` token used to publish this repository did not have the `workflow` scope, so the file is not under `.github/workflows/` yet. To enable Pages, copy it to `.github/workflows/pages.yml` (or add it in the GitHub UI) and set the Pages source to GitHub Actions. The CORS origin for Pages is `https://drmessi007-ui.github.io` (the origin has no path).

## License

MIT License, Copyright (c) 2026 Jose Ignacio Garcia Ojeda (same terms as OrbitHire).

## Español (resumen)

StarkHire es un prototipo nuevo en Starknet Sepolia, derivado del propio OrbitHire del autor (ese proyecto NEAR sigue aparte y no se modifica). El contrato Cairo y las pruebas del agente pasan en local; el contrato **no** está desplegado y el agente **no** está instalado en el servidor. El subdominio previsto `starkhire.deosorno.cl` debe crearse en DNS antes de exponer el API. No uses cuentas ni claves de mainnet. Quien opera el proyecto debe crear las wallets de Sepolia (dueño/desplegador y agente), fondearlas, desplegar el contrato, publicar su dirección, y aprobar cualquier instalación en el servidor. Instrucciones: `deploy/INSTALL.md`.
