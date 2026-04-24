// @file        clients/js/test/community/_common.ts
// @description Helpers for SnowChat Community Fee Share ava tests. Handles
//              NFT minting with a verified leader-creator, PDA derivation,
//              and the register/revoke instruction plumbing.
// @author      Kennt Kim
// @company     Calida Lab
// @created     2026-04-24
// @lastUpdated 2026-04-24

import {
  Address,
  appendTransactionMessageInstruction,
  KeyPairSigner,
  pipe,
} from '@solana/web3.js';
import { createDefaultNft } from '@tensor-foundation/mpl-token-metadata';
import {
  Client,
  createDefaultSolanaClient,
  createDefaultTransaction,
  generateKeyPairSignerWithSol,
  ONE_SOL,
  signAndSendTransaction,
} from '@tensor-foundation/test-helpers';
import {
  fetchCommunityRegistration,
  findCommunityRegistrationPda,
  getRegisterCommunityCollectionInstructionAsync,
  getRevokeCommunityCollectionInstruction,
} from '../../src/index.js';

export const SNOWCHAT_ID_LEN = 36;
export const CHANNEL_ID_LEN = 32;
export const COOLDOWN_SECS = 30 * 24 * 60 * 60;
export const LEADER_SHARE_BPS = 5_000n;

export interface CommunitySigners {
  leader: KeyPairSigner;
  buyer: KeyPairSigner;
  seller: KeyPairSigner;
  payer: KeyPairSigner;
}

export async function getCommunitySigners(
  client: Client
): Promise<CommunitySigners> {
  const leader = await generateKeyPairSignerWithSol(client, 5n * ONE_SOL);
  const buyer = await generateKeyPairSignerWithSol(client, 5n * ONE_SOL);
  const seller = await generateKeyPairSignerWithSol(client, 5n * ONE_SOL);
  const payer = await generateKeyPairSignerWithSol(client, 5n * ONE_SOL);
  return { leader, buyer, seller, payer };
}

/**
 * Build a fake but well-formed SnowChat ID bytes buffer ("snow" + 32 hex = 36).
 */
export function makeSnowchatIdBytes(hexSuffix?: string): Array<number> {
  const suffix =
    hexSuffix ??
    Array(32)
      .fill(0)
      .map((_, i) => ((i * 7 + 3) % 16).toString(16))
      .join('');
  const ascii = `snow${suffix}`;
  if (ascii.length !== SNOWCHAT_ID_LEN) {
    throw new Error(
      `SnowChat ID must be ${SNOWCHAT_ID_LEN} ASCII bytes (got ${ascii.length})`
    );
  }
  return Array.from(new TextEncoder().encode(ascii));
}

/**
 * Build a 32-byte channel_id buffer from a stable seed.
 */
export function makeChannelIdBytes(seed = 'SnowChatCommunityChannelSeedXX00'): Uint8Array {
  if (seed.length !== CHANNEL_ID_LEN) {
    throw new Error(
      `channel_id seed must be ${CHANNEL_ID_LEN} ASCII bytes (got ${seed.length})`
    );
  }
  return new TextEncoder().encode(seed);
}

export interface MintedCollectionParams {
  client: Client;
  payer: KeyPairSigner;
  leader: KeyPairSigner;
  buyerAddress?: Address;
}

export interface MintedCollection {
  mint: Address;
  metadata: Address;
  owner: Address;
}

/**
 * Mint an NFT where `leader` is both the update_authority AND a verified
 * creator with 100% share. This is the canonical configuration required
 * by `apply_community_share` (leader_wallet must appear with verified=true
 * in metadata.creators[]).
 */
export async function mintCommunityEligibleNft(
  params: MintedCollectionParams
): Promise<MintedCollection> {
  const { client, payer, leader, buyerAddress } = params;
  const owner = buyerAddress ?? payer.address;
  const { mint, metadata } = await createDefaultNft({
    client,
    payer,
    authority: leader,
    owner,
  });
  return { mint, metadata, owner };
}

/**
 * Register the collection on-chain with `leader` as the community leader.
 * Returns the derived registration PDA.
 */
export async function registerCollection({
  client,
  leader,
  collectionMint,
  metadata,
  leaderSnowchatId,
  channelId,
}: {
  client: Client;
  leader: KeyPairSigner;
  collectionMint: Address;
  metadata: Address;
  leaderSnowchatId: Array<number>;
  channelId: Uint8Array;
}): Promise<Address> {
  const [registration] = await findCommunityRegistrationPda({
    collectionMint,
  });
  const ix = await getRegisterCommunityCollectionInstructionAsync({
    registration,
    collectionMint,
    metadata,
    leader,
    leaderSnowchatId,
    channelId,
  });
  await pipe(
    await createDefaultTransaction(client, leader),
    (tx) => appendTransactionMessageInstruction(ix, tx),
    (tx) => signAndSendTransaction(client, tx)
  );
  return registration;
}

/**
 * Revoke a previously registered collection. Marks soft-delete + emits
 * event. Cooldown enforced on-chain (30 days since registration).
 */
export async function revokeCollection({
  client,
  leader,
  collectionMint,
}: {
  client: Client;
  leader: KeyPairSigner;
  collectionMint: Address;
}): Promise<void> {
  const [registration] = await findCommunityRegistrationPda({
    collectionMint,
  });
  const ix = getRevokeCommunityCollectionInstruction({
    registration,
    leader,
  });
  await pipe(
    await createDefaultTransaction(client, leader),
    (tx) => appendTransactionMessageInstruction(ix, tx),
    (tx) => signAndSendTransaction(client, tx)
  );
}

export async function fetchRegistration(client: Client, registration: Address) {
  return await fetchCommunityRegistration(client.rpc, registration);
}

/**
 * Fresh Solana client per test — each ava test gets its own validator state
 * via @tensor-foundation/test-helpers localnet fixture.
 */
export function makeClient(): Client {
  return createDefaultSolanaClient();
}
