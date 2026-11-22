# StarkHire frontend

Static page. Open `index.html` after setting `CONTRACT_ADDRESS` in `app.js` (leave it empty until the escrow is deployed on Starknet Sepolia).

- Wallet: Argent or Braavos through `@starknet-io/get-starknet`.
- Agent: `AGENT_API_URL = https://starkhire.deosorno.cl`.
- GitHub Pages cannot inject environment variables; change those constants before publishing.
- Visual theme derived from the author's OrbitHire frontend.

The page refuses to treat a mainnet wallet as usable for payments.
