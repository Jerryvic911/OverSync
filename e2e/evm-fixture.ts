/**
 * evm-fixture.ts
 *
 * Deploys HTLCEscrow against Hardhat's in-process network using ethers v6.
 *
 * Prerequisites:
 *   - Run `pnpm hardhat compile` inside `contracts/` at least once.
 *   - Start the Hardhat node in a separate terminal:
 *       cd contracts && pnpm hardhat node
 *
 * Local EVM fixture:
 *   startEvmFixture() calls hardhat_reset before every test so nonces
 *   and contract addresses are fully deterministic across test runs.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { ethers } from "ethers";

export type Hex = `0x${string}`;

// ── Load artifact ─────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const artifactPath = join(
  __dirname,
  "../contracts/artifacts/contracts/v2/HTLCEscrow.sol/HTLCEscrow.json"
);
const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
const HTLC_ABI = artifact.abi;
const HTLC_BYTECODE = artifact.bytecode as string;

// ── Constants ─────────────────────────────────────────────────────────────────

const AMOUNT = ethers.parseEther("0.5");
const SAFETY_DEPOSIT = 0n;
const ZERO_ADDR = ethers.ZeroAddress;
const HARDHAT_RPC = "http://127.0.0.1:8545";

// Hardhat default funded accounts (publicly known — never use on mainnet)
const DEPLOYER_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const BENEFICIARY_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RealEvmHtlcFixture {
  createOrder(hashlock: Hex, timelockSeconds: number): Promise<bigint>;
  claimOrder(orderId: bigint, preimage: Hex): Promise<void>;
  claimOrderExpectRevert(orderId: bigint, preimage: Hex): Promise<string>;
  getOrderStatus(orderId: bigint): Promise<"Funded" | "Claimed" | "Refunded">;
  stop(): Promise<void>;
}

const STATUS_MAP = ["Funded", "Claimed", "Refunded"] as const;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Decode a raw 4-byte revert selector against the contract ABI. */
function decodeCustomError(data: string | undefined): string | null {
  if (!data || data.length < 10) return null;
  const selector = data.slice(0, 10).toLowerCase();
  const iface = new ethers.Interface(HTLC_ABI);
  for (const fragment of iface.fragments) {
    if (fragment.type === "error") {
      const computed = iface.getError(fragment.name)?.selector;
      if (computed?.toLowerCase() === selector) return fragment.name;
    }
  }
  return null;
}

// ── Fixture ───────────────────────────────────────────────────────────────────

export async function startEvmFixture(): Promise<RealEvmHtlcFixture> {
  // Fresh provider on every call — no cached nonce state carried over
  const provider = new ethers.JsonRpcProvider(HARDHAT_RPC, undefined, {
    cacheTimeout: -1,
    polling: true,
  });

  // Reset Hardhat to block 0 — nonces restart at 0, state is clean
  await provider.send("hardhat_reset", []);

  // NonceManager wraps the wallet and always queries the node for the
  // current nonce instead of incrementing an internal counter — this
  // is the ethers v6 solution to stale-nonce after hardhat_reset.
  const deployerWallet = new ethers.Wallet(DEPLOYER_KEY, provider);
  const beneficiaryWallet = new ethers.Wallet(BENEFICIARY_KEY, provider);
  const deployer = new ethers.NonceManager(deployerWallet);
  const beneficiary = new ethers.NonceManager(beneficiaryWallet);

  // Deploy HTLCEscrow(address(0), 0) — permissionless, no min deposit
  const factory = new ethers.ContractFactory(HTLC_ABI, HTLC_BYTECODE, deployer);
  const contract = await factory.deploy(ZERO_ADDR, 0n);
  await contract.waitForDeployment();
  const contractAddress = await contract.getAddress();

  // Reset NonceManager counters after deploy so createOrder starts fresh
  deployer.reset();
  beneficiary.reset();

  const escrow = new ethers.Contract(contractAddress, HTLC_ABI, deployer);
  const escrowAsBeneficiary = new ethers.Contract(contractAddress, HTLC_ABI, beneficiary);

  return {
    async createOrder(hashlock: Hex, timelockSeconds: number): Promise<bigint> {
      const total = AMOUNT + SAFETY_DEPOSIT;

      // Reset before each tx so NonceManager re-queries from the node
      deployer.reset();

      const tx = await escrow.createOrder(
        beneficiaryWallet.address,
        deployerWallet.address,
        ZERO_ADDR,
        AMOUNT,
        SAFETY_DEPOSIT,
        hashlock,
        timelockSeconds,
        { value: total }
      );
      const receipt = await tx.wait();

      const iface = new ethers.Interface(HTLC_ABI);
      for (const log of receipt.logs) {
        try {
          const parsed = iface.parseLog(log);
          if (parsed?.name === "OrderCreated") {
            return parsed.args.orderId as bigint;
          }
        } catch {
          // skip unparseable logs
        }
      }
      throw new Error("OrderCreated event not found in receipt");
    },

    async claimOrder(orderId: bigint, preimage: Hex): Promise<void> {
      beneficiary.reset();
      const tx = await escrowAsBeneficiary.claimOrder(orderId, preimage);
      await tx.wait();
    },

    async claimOrderExpectRevert(orderId: bigint, preimage: Hex): Promise<string> {
      // staticCall never broadcasts — no nonce consumed
      try {
        await escrowAsBeneficiary.claimOrder.staticCall(orderId, preimage);
        return "";
      } catch (e: any) {
        const rawData: string | undefined = e?.data ?? e?.error?.data;
        const decoded = decodeCustomError(rawData);
        if (decoded) return decoded;
        return e?.errorName ?? e?.reason ?? e?.message ?? String(e);
      }
    },

    async getOrderStatus(orderId: bigint): Promise<"Funded" | "Claimed" | "Refunded"> {
      const order = await escrow.getOrder(orderId);
      return STATUS_MAP[Number(order.status)];
    },

    async stop(): Promise<void> {
      await provider.destroy();
    },
  };
}