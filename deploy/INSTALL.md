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

## 2. Node 22 runtime (do not modify existing trees)

On this host, Node.js `v22.23.5` already exists at `/opt/node22/bin/node`. The unit points `ExecStart` at that binary and does not modify `/opt/node22` or `/opt/orbithire-runtime`.

When running `npm`, put `/opt/node22/bin` first on `PATH` and invoke npm with that Node, because `/opt/node22/bin/npm` uses `#!/usr/bin/env node` and would otherwise pick the system Node `v20`:

```bash
sudo -u starkhire env PATH=/opt/node22/bin:/usr/bin:/bin   /opt/node22/bin/node /opt/node22/bin/npm ci --omit=dev
```

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
# Do not start until STARKHIRE_CONTRACT_ADDRESS, AGENT_ACCOUNT_ADDRESS,
# and AGENT_PRIVATE_KEY are set: the process exits on boot without them.
# sudo systemctl start starkhire-agent.service
sudo systemctl status starkhire-agent.service --no-pager
curl -sS http://127.0.0.1:8797/health
```

Expected health JSON once the contract and agent key are configured, the unit is started, and Sepolia RPC is reachable: `{"ok":true,"network":"sepolia","service":"starkhire-agent"}`.

If start fails, inspect logs with `journalctl -u starkhire-agent.service -n 100 --no-pager`. Do not restart or edit `orbithire-agent.service` while debugging.

## 6. Hestia domain for starkhire.deosorno.cl (do not run until DNS exists)

This host does not use `/etc/nginx/sites-enabled`. Vhosts are Hestia symlinks under `/etc/nginx/conf.d/domains/`. `agent.deosorno.cl` belongs to Hestia user `dns`, IP `10.0.0.183` (NAT `136.248.242.17`), proxy template `orbithire` (that template proxies to `http://127.0.0.1:18787` — never assign it to StarkHire).

Templates for StarkHire (port `8797`) are in [`hestia/starkhire.tpl`](hestia/starkhire.tpl) and [`hestia/starkhire.stpl`](hestia/starkhire.stpl). They were **not** copied to the server in the 2026-11-22 install window, and no domain or certificate was created, because `starkhire.deosorno.cl` had no public DNS record.

When the owner has created the DNS A (or CNAME) record pointing at `136.248.242.17` and has approved the web/TLS change, run only these commands (new files and a new domain; do not edit `orbithire.tpl`, `orbithire.stpl`, or the `agent.deosorno.cl` vhost):

```bash
# 1. Install the new templates as new files only.
sudo cp deploy/hestia/starkhire.tpl /usr/local/hestia/data/templates/web/nginx/starkhire.tpl
sudo cp deploy/hestia/starkhire.stpl /usr/local/hestia/data/templates/web/nginx/starkhire.stpl
sudo chown root:root /usr/local/hestia/data/templates/web/nginx/starkhire.tpl \
  /usr/local/hestia/data/templates/web/nginx/starkhire.stpl
sudo chmod 644 /usr/local/hestia/data/templates/web/nginx/starkhire.tpl \
  /usr/local/hestia/data/templates/web/nginx/starkhire.stpl

# 2. Add the domain under the same Hestia user as agent.deosorno.cl.
sudo /usr/local/hestia/bin/v-add-web-domain dns starkhire.deosorno.cl 10.0.0.183

# 3. Attach the StarkHire proxy template (127.0.0.1:8797).
#    If PROXY is not enabled yet on the new domain, use v-add-web-domain-proxy
#    with the same arguments instead.
sudo /usr/local/hestia/bin/v-change-web-domain-proxy-tpl dns starkhire.deosorno.cl starkhire

# 4. Let's Encrypt (requires the DNS record to already resolve here).
sudo /usr/local/hestia/bin/v-add-letsencrypt-domain dns starkhire.deosorno.cl

# 5. Verify the new site, and confirm OrbitHire is unchanged.
sudo /usr/local/hestia/bin/v-list-web-domain dns starkhire.deosorno.cl
curl -sS https://starkhire.deosorno.cl/health
curl -sS https://agent.deosorno.cl/health
```

The generic file `nginx-starkhire.deosorno.cl.conf` is only a starting example; it is not how this host's Nginx is laid out.

## 7. Frontend

Set `CONTRACT_ADDRESS` in `frontend/app.js` to the deployed Sepolia address, commit, and update both `main` and the `gh-pages` branch (the live site is https://drmessi007-ui.github.io/starkhire/). The agent `FRONTEND_ORIGIN` is `https://drmessi007-ui.github.io` (the origin has no path). The optional Actions workflow remains at `deploy/github-pages.yml`.


## Host notes from the 2026-11-22 read-only survey

A non-mutating login to the machine that serves `agent.deosorno.cl` (`ns1.deosorno.cl`, public A record `136.248.242.17`) found the following. Nothing on the host was changed.

- Nginx does **not** use `/etc/nginx/sites-enabled`. Vhosts are Hestia symlinks in `/etc/nginx/conf.d/domains/`. `agent.deosorno.cl` is already there (`agent.deosorno.cl.conf` and `agent.deosorno.cl.ssl.conf`, under the Hestia user `dns`). The TLS server block proxies to `http://127.0.0.1:18787`. Listen addresses are `10.0.0.183:80` and `10.0.0.183:443`, not `0.0.0.0`.
- Adding `starkhire.deosorno.cl` should follow that Hestia layout (new domain beside the existing ones, TLS through the host's existing certificate process). Do not overwrite `agent.deosorno.cl` or other domain files. The generic file `nginx-starkhire.deosorno.cl.conf` is only a starting example and must be adapted to those listen addresses and paths.
- `orbithire-agent.service` was active and listening on `127.0.0.1:18787`. Ports `8787` and `8797` had no TCP listener.
- Isolated Node.js `v22.23.5` binaries already exist at `/opt/orbithire-runtime/node-v22.23.5/bin/node` and `/opt/node22/bin/node`. Either may be referenced read-only from a new unit; do not replace those trees. System `/usr/bin/node` was `v20.20.2`.
- The host had about 1 GiB of RAM with swap in use, plus mail, DNS, Hestia, Apache, Nginx, MariaDB, and the OrbitHire agent. A second Node process should only be installed after the owner accepts that memory risk.
- No `/opt/starkhire-agent`, `/etc/starkhire-agent`, or `starkhire-agent.service` existed at survey time.

## Status after the 2026-11-22 approved install window

The owner approved installing the agent and enabling GitHub Pages on 22 Nov 2026. The following was done on `ns1.deosorno.cl`. No OrbitHire path, unit, vhost, or env file was changed. No Hestia domain or TLS certificate was created.

- App files: `/opt/starkhire-agent/app` (only `package.json`, `package-lock.json`, `src/`, and `node_modules` from `npm ci --omit=dev`). Data dir: `/opt/starkhire-agent/app/data`.
- System user `starkhire` (`nologin`).
- Env file: `/etc/starkhire-agent/agent.env` (owner `root:starkhire`, mode `0640`), bound to `127.0.0.1:8797`, `FRONTEND_ORIGIN=https://drmessi007-ui.github.io`, `STARKNET_NETWORK=sepolia`. Contract address and agent key fields were left empty.
- Unit: `/etc/systemd/system/starkhire-agent.service`, enabled, **left stopped** because the process cannot boot without a contract address and agent key. Limits: `MemoryMax=192M`, `MemoryHigh=160M`, `CPUQuota=50%`, `Nice=10`, `NODE_OPTIONS=--max-old-space-size=128`, `RestartSec=30`, `StartLimitBurst=3` / `StartLimitIntervalSec=300`. `ExecStart=/opt/node22/bin/node`.
- After `daemon-reload` and `enable`, `orbithire-agent.service` remained active with the same main PID as before the install, and `https://agent.deosorno.cl/health` still returned `{"ok":true,"network":"testnet"}`.

