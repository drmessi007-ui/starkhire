import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  addressesEqual,
  assertSepoliaOnly,
  createChain,
  isValidUuidV4,
  loadConfig,
  requestKeyFromId,
  sha256Hex,
  sha256U256,
  STATUS,
  toBigInt,
} from "../src/starknet-chain.js";

const UUID = "550e8400-e29b-41d4-a716-446655440000";

describe("validators and hashing", () => {
  it("accepts lowercase UUID v4 and rejects other versions", () => {
    assert.equal(isValidUuidV4(UUID), true);
    assert.equal(isValidUuidV4("550e8400-e29b-41d4-a716-446655440000".toUpperCase()), false);
    assert.equal(isValidUuidV4("550e8400-e29b-31d4-a716-446655440000"), false);
    assert.equal(isValidUuidV4("not-a-uuid"), false);
  });

  it("hashes text with SHA-256 as hex and u256", () => {
    assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    assert.equal(sha256U256("abc"), 0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015adn);
  });

  it("masks the request key to 251 bits", () => {
    const key = requestKeyFromId(UUID);
    assert.equal(typeof key, "bigint");
    assert.ok(key < (1n << 251n));
    assert.ok(key > 0n);
    assert.throws(() => requestKeyFromId("bad"), /invalid request id/);
  });

  it("normalizes addresses for equality", () => {
    assert.equal(
      addressesEqual("0x0000000000000000000000000000000000000000000000000000000000000001", "0x1"),
      true,
    );
    assert.equal(addressesEqual("0x2", "0x1"), false);
  });

  it("converts u256 structs and hex strings to bigint", () => {
    assert.equal(toBigInt({ low: 1, high: 0 }), 1n);
    assert.equal(toBigInt("0x10"), 16n);
    assert.equal(toBigInt(7), 7n);
  });
});

describe("sepolia-only config", () => {
  it("refuses mainnet network or RPC", () => {
    assert.throws(
      () => assertSepoliaOnly({ network: "mainnet", rpcUrl: "https://example" }),
      /refuses to start on Starknet mainnet/,
    );
    assert.throws(
      () => assertSepoliaOnly({ network: "sepolia", rpcUrl: "https://starknet-mainnet.public.blastapi.io" }),
      /refuses to start on Starknet mainnet/,
    );
  });

  it("accepts sepolia", () => {
    assert.doesNotThrow(() =>
      assertSepoliaOnly({ network: "sepolia", rpcUrl: "https://starknet-sepolia.public.blastapi.io" }),
    );
  });

  it("loadConfig refuses mainnet even if other fields are set", () => {
    assert.throws(
      () =>
        loadConfig({
          STARKNET_NETWORK: "mainnet",
          STARKNET_RPC_URL: "https://example",
          STARKHIRE_CONTRACT_ADDRESS: "0x1",
          AGENT_ACCOUNT_ADDRESS: "0x2",
          AGENT_PRIVATE_KEY: "0x3",
        }),
      /mainnet/,
    );
  });
});

describe("createChain with a mocked contract", () => {
  const commitment = sha256U256("kp index tonight");

  function mockContract() {
    const state = {
      status: STATUS.OPEN,
      commitment,
      fee: 1_000_000_000_000_000_000n,
      token: "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d",
      agent: "0xabc",
      submitted: [],
    };
    return {
      state,
      get_fee: async () => state.fee,
      get_token: async () => state.token,
      get_agent: async () => state.agent,
      get_request_status: async () => state.status,
      get_request_commitment: async () => state.commitment,
      get_report_hash: async () => 0n,
      get_refund_after: async () => 0,
      submit_report: async (requestId, reportHash) => {
        state.submitted.push({ requestId, reportHash });
        state.status = STATUS.REPORT_SUBMITTED;
        return { transaction_hash: "0xdead" };
      },
    };
  }

  it("views fee/token/agent and verifies the query commitment", async () => {
    const contract = mockContract();
    const chain = createChain(
      { network: "sepolia", rpcUrl: "http://127.0.0.1:1", contractAddress: "0x1", agentAddress: "0xabc", privateKey: "0x1" },
      { contract, provider: { waitForTransaction: async () => ({}) } },
    );
    assert.equal(await chain.getFee(), 1_000_000_000_000_000_000n);
    assert.equal(await chain.getAgent(), "0xabc");
    await chain.assertQueryMatchesOnChain(UUID, "kp index tonight");
  });

  it("rejects a query that does not match the on-chain commitment", async () => {
    const contract = mockContract();
    const chain = createChain(
      { network: "sepolia", rpcUrl: "http://127.0.0.1:1", contractAddress: "0x1", agentAddress: "0xabc", privateKey: "0x1" },
      { contract },
    );
    await assert.rejects(
      () => chain.assertQueryMatchesOnChain(UUID, "something else"),
      /does not match the on-chain request commitment/,
    );
  });

  it("rejects notify when the request is not open", async () => {
    const contract = mockContract();
    contract.state.status = STATUS.REPORT_SUBMITTED;
    const chain = createChain(
      { network: "sepolia", rpcUrl: "http://127.0.0.1:1", contractAddress: "0x1", agentAddress: "0xabc", privateKey: "0x1" },
      { contract },
    );
    await assert.rejects(
      () => chain.assertQueryMatchesOnChain(UUID, "kp index tonight"),
      /request is not open/,
    );
  });

  it("submitReport calls the contract and returns the tx hash", async () => {
    const contract = mockContract();
    const chain = createChain(
      { network: "sepolia", rpcUrl: "http://127.0.0.1:1", contractAddress: "0x1", agentAddress: "0xabc", privateKey: "0x1" },
      { contract, waitForTransaction: async () => ({}) },
    );
    const result = await chain.submitReport(UUID, 0xabcdefn);
    assert.equal(result.transactionHash, "0xdead");
    assert.equal(contract.state.submitted.length, 1);
    assert.equal(contract.state.submitted[0].reportHash, 0xabcdefn);
  });
});
