// @file        clients/js/test/community/_common.ts
// @description Helpers for SnowChat Community Fee Share ava tests.
//              Post-audit (Phase B.5) rewrite: mints a properly-verified
//              Metaplex Collection + child NFT, seals the collection
//              metadata (`is_mutable=false`) so `register_community_collection`
//              accepts it, and exposes register / revoke / fetch helpers.
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
import {
  createDefaultNftInCollection,
  getUpdateMetadataAccountV2Instruction,
} from '@tensor-foundation/mpl-token-metadata';
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
export const MIN_LEADER_SHARE_LAMPORTS = 1_000n;

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

export function makeChannelIdBytes(
  seed = 'SnowChatCommunityChannelSeedXX00'
): Uint8Array {
  if (seed.length !== CHANNEL_ID_LEN) {
    throw new Error(
      `channel_id seed must be ${CHANNEL_ID_LEN} ASCII bytes (got ${seed.length})`
    );
  }
  return new TextEncoder().encode(seed);
}

export interface CommunityPair {
  /** Parent Collection NFT — registration uses this mint as PDA seed. */
  collectionMint: Address;
  /** Collection metadata PDA (leader is update_authority + verified creator). */
  collectionMetadata: Address;
  /** Child NFT — the actual asset that gets listed/bought. */
  itemMint: Address;
  /** Child metadata PDA (verified=true member of the collection). */
  itemMetadata: Address;
}

/**
 * Mint a properly-verified Collection + child NFT pair where `leader` is the
 * update_authority and auto-verified creator on both. The collection metadata
 * is sealed (`is_mutable = false`) so `register_community_collection` will
 * accept it under the new P1-1 check.
 *
 * The child NFT's `metadata.collection.verified` is set to true by
 * `createDefaultNftInCollection`'s internal `VerifyCollectionV1` call.
 */
export async function mintSealedCommunityPair({
  client,
  leader,
}: {
  client: Client;
  leader: KeyPairSigner;
}): Promise<CommunityPair> {
  const { collection, item } = await createDefaultNftInCollection({
    client,
    payer: leader,
    authority: leader,
    owner: leader.address,
  });

  // Seal collection metadata so P1-1 passes. The other fields are untouched
  // (data=null, updateAuthorityArg=null, primarySaleHappened=null).
  const sealIx = getUpdateMetadataAccountV2Instruction({
    metadata: collection.metadata,
    updateAuthority: leader,
    data: null,
    updateAuthorityArg: null,
    primarySaleHappened: null,
    isMutable: false,
  });
  await pipe(
    await createDefaultTransaction(client, leader),
    (tx) => appendTransactionMessageInstruction(sealIx, tx),
    (tx) => signAndSendTransaction(client, tx)
  );

  return {
    collectionMint: collection.mint,
    collectionMetadata: collection.metadata,
    itemMint: item.mint,
    itemMetadata: item.metadata,
  };
}

/**
 * Mint a pair WITHOUT sealing the collection metadata. Useful for testing
 * that `register_community_collection` rejects mutable metadata (P1-1).
 */
export async function mintUnsealedCommunityPair({
  client,
  leader,
}: {
  client: Client;
  leader: KeyPairSigner;
}): Promise<CommunityPair> {
  const { collection, item } = await createDefaultNftInCollection({
    client,
    payer: leader,
    authority: leader,
    owner: leader.address,
  });
  return {
    collectionMint: collection.mint,
    collectionMetadata: collection.metadata,
    itemMint: item.mint,
    itemMetadata: item.metadata,
  };
}

export async function registerCollection({
  client,
  leader,
  collectionMint,
  collectionMetadata,
  leaderSnowchatId,
  channelId,
}: {
  client: Client;
  leader: KeyPairSigner;
  collectionMint: Address;
  collectionMetadata: Address;
  leaderSnowchatId: Array<number>;
  channelId: Uint8Array;
}): Promise<Address> {
  const [registration] = await findCommunityRegistrationPda({
    collectionMint,
  });
  const ix = await getRegisterCommunityCollectionInstructionAsync({
    registration,
    collectionMint,
    metadata: collectionMetadata,
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

export function makeClient(): Client {
  return createDefaultSolanaClient();
}
