# StarkHire agent — safe install checklist

These files are templates in the repository. They are **not** installed automatically. Do not run any of the commands below on the production host until the owner approves a server change window. Never touch OrbitHire paths or services:

- `/opt/orbithire-agent`
- `/etc/orbithire-agent`
- `orbithire-agent.service`
- `/opt/orbithire-runtime` (you may *read* the Node binary path; do not replace, delete, or reconfigure it)
- the Nginx site for `agent.deosorno.cl`

This prototype must stay on **Starknet Sepolia**. The agent refuses to start on mainnet.

## 0. Prerequisites the owner must complete first

1. Create two Starknet Sepolia accounts in a wallet the owner controls (Argent or Braavos, or an equivalent signer): one **deployer/owner** and one **agent**. Do not use a mainnet key. Do not paste seed phrases into this repository or into chat.
2. Fund both accounts on Sepolia (official / documented faucets only). The deployer also needs the ERC-20 token that will be configured as the fee token, plus enough ETH/STRK to pay deployment fees.
3. Deploy the Cairo contract in `src/starkhire.cairo` to Sepolia (`sncast` or an equivalent tool). Constructor arguments: owner, agent, fee token address, fee amount, refund window (seconds), rate-limit window (seconds). Publish the contract address in the README and set `CONTRACT_ADDRESS` in `frontend/app.js`.
4. Create a DNS **A** (or CNAME) record for `starkhire.deosorno.cl` pointing at the same host that already serves `agent.deosorno.cl`, or at another host the owner chooses. As of the initial repository publication this name had no public DNS record.
5. Approve a change window on the server.

## 1. Read-only survey (do this first, even after approval)

```bash
uptime
df -h
free -m
systemctl list-units --type=service --state=running
ss -ltnp
ls /etc/nginx/sites-enabled
nginx -T 2>/dev/null | head
node -v
# If an isolated Node runtime exists, only print its version; do not modify it:
# /opt/orbithire-runtime/node-v22.23.5/bin/node -v
ss -H -ltn 'sport = :8797'
```

Choose a free TCP port if `8797` is already taken. Do not stop other listeners to free a port.

## 2. Install a Node 22+ runtime without touching OrbitHire

Option A — reuse the existing isolated binary **read-only** by pointing `ExecStart` at it, without changing files under `/opt/orbithire-runtime`.

Option B — install a separate runtime under `/opt/starkhire-runtime` (official Node tarball, checksum-verified). Do not create `/usr/bin` symlinks or change the system `PATH`.

Then edit `deploy/starkhire-agent.service` so `PATH` and `ExecStart` match the binary you chose.

## 3. Create an isolated service account and directories

```bash
sudo useradd --system --home /opt/starkhire-agent --shell /usr/sbin/nologin starkhire || true
sudo install -d -o starkhire -g starkhire -m 0750 /opt/starkhire-agent/app
sudo install -d -o starkhire -g starkhire -m 0750 /opt/starkhire-agent/app/data
sudo install -d -o root -g starkhire -m 0750 /etc/starkhire-agent
```

Copy only `agent/package.json`, `agent/package-lock.json`, and `agent/src/` into `/opt/starkhire-agent/app`. Never copy `.env`, `secrets/`, wallets, or the OrbitHire tree.

```bash
sudo -u starkhire bash -lc 'cd /opt/starkhire-agent/app && /path/to/npm ci --omit=dev'
```

## 4. Environment file

```bash
sudo cp deploy/agent.env.example /etc/starkhire-agent/agent.env
sudo chown root:starkhire /etc/starkhire-agent/agent.env
sudo chmod 0640 /etc/starkhire-agent/agent.env
# Edit the file: contract address, agent account, agent private key,
# STARKNET_RPC_URL, FRONTEND_ORIGIN, SERVICE_PORT.
```

`FRONTEND_ORIGIN` must be the exact HTTPS origin of the static frontend (no path). For GitHub Pages that is `https://drmessi007-ui.github.io`.

## 5. systemd unit

```bash
sudo cp deploy/starkhire-agent.service /etc/systemd/system/starkhire-agent.service
# Adjust ExecStart / PATH if needed, then:
sudo systemctl daemon-reload
sudo systemctl enable starkhire-agent.service
sudo systemctl start starkhire-agent.service
sudo systemctl status starkhire-agent.service --no-pager
curl -sS http://127.0.0.1:8797/health
```

Expected health JSON once the contract address is set and Sepolia RPC is reachable: `{"ok":true,"network":"sepolia","service":"starkhire-agent"}`.

If start fails, inspect logs with `journalctl -u starkhire-agent.service -n 100 --no-pager`. Do not restart or edit `orbithire-agent.service` while debugging.

## 6. Nginx site for starkhire.deosorno.cl

Only after DNS resolves to this host:

```bash
# Copy deploy/nginx-starkhire.deosorno.cl.conf into the host's usual
# sites-available / sites-enabled layout (do not overwrite other sites).
sudo nginx -t
# Configure TLS with the host's existing certificate process, then:
# sudo systemctl reload nginx
curl -sS https://starkhire.deosorno.cl/health
```

## 7. Frontend

Set `CONTRACT_ADDRESS` in `frontend/app.js` to the deployed Sepolia address, commit, and publish the `frontend/` directory (GitHub Pages from the workflow in `.github/workflows/pages.yml`, or another static host). The agent CORS origin must match that host origin.
