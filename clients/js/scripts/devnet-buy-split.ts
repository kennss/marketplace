// @file        clients/js/scripts/devnet-buy-split.ts
// @description Devnet E2E for SnowChat Community Fee Share buy flow.
//              leader (=update_authority, =verified creator, =seller)
//              lists an NFT, a buyer purchases, fee split is measured
//              via the CommunityRegistration PDA's cumulativeShareLamports
//              and tradeCount counters (lamport-exact verification).
// @author      Kennt Kim
// @company     Calida Lab
// @created     2026-04-24
// @lastUpdated 2026-04-24
//
// Run: cd clients/js && pnpm tsx scripts/devnet-buy-split.ts

import {
  address,
  Address,
  appendTransactionMessageInstruction,
  generateKeyPairSigner,
  pipe,
} from '@solana/web3.js';
import { getTransferSolInstruction } from '@solana-program/system';
import {
  createDefaultNftInCollection,
  getUpdateMetadataAccountV2Instruction,
} from '@tensor-foundation/mpl-token-metadata';
import {
  createDefaultSolanaClient,
  createDefaultTransaction,
  createKeyPairSigner,
  signAndSendTransaction,
} from '@tensor-foundation/test-helpers';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  fetchCommunityRegistration,
  findCommunityRegistrationPda,
  findFeeVaultPda,
  findListStatePda,
  getBuyLegacyInstructionAsync,
  getListLegacyInstructionAsync,
  getRegisterCommunityCollectionInstructionAsync,
} from '../src/index.js';

const PROGRAM_ADDRESS = address('BJMvy7BcwsTXyHP6Ua7ekeE7DUoN2i9KrQyEhgqVJ32z');
const DEVNET_RPC = 'https://api.devnet.solana.com';
const KEYPAIR_PATH = join(homedir(), '.config', 'solana', 'id.json');

const SNOWCHAT_ID = 'snowabcdef0123456789abcdef0123456789';
const CHANNEL_SEED = 'SnowChatDevnetBuySplit0987654321';

const LISTING_PRICE = 100_000_000n; // 0.1 SOL
const BASIS_POINTS = 10_000n;
const TAKER_FEE_BPS = 200n;
const BROKER_FEE_PCT = 50n;
const HUNDRED_PCT = 100n;
const LEADER_SHARE_BPS = 5_000n;

function snowchatIdBytes(): Array<number> {
  if (SNOWCHAT_ID.length !== 36) {
    throw new Error(`SNOWCHAT_ID must be 36 bytes, got ${SNOWCHAT_ID.length}`);
  }
  return Array.from(new TextEncoder().encode(SNOWCHAT_ID));
}

function channelIdBytes(): Uint8Array {
  if (CHANNEL_SEED.length !== 32) {
    throw new Error(`CHANNEL_SEED must be 32 bytes, got ${CHANNEL_SEED.length}`);
  }
  return new TextEncoder().encode(CHANNEL_SEED);
}

async function loadKeypair() {
  const raw = readFileSync(KEYPAIR_PATH, 'utf-8');
  return createKeyPairSigner(Uint8Array.from(JSON.parse(raw)));
}

function expectedProtocolFee(price: bigint): bigint {
  const total = (price * TAKER_FEE_BPS) / BASIS_POINTS;
  const broker = (total * BROKER_FEE_PCT) / HUNDRED_PCT;
  return total - broker;
}

function expectedLeaderShare(protocolFee: bigint): bigint {
  return (protocolFee * LEADER_SHARE_BPS) / BASIS_POINTS;
}

async function main() {
  console.log(`▶ devnet buy-split E2E — program ${PROGRAM_ADDRESS}`);
  const client = createDefaultSolanaClient(DEVNET_RPC);
  const leader = await loadKeypair();
  console.log(`  leader/seller: ${leader.address}`);

  // Generate a fresh buyer keypair and fund from leader.
  const buyer = await generateKeyPairSigner();
  console.log(`  buyer        : ${buyer.address}`);
  console.log('▶ funding buyer with 0.3 SOL from leader...');
  const transferIx = getTransferSolInstruction({
    source: leader,
    destination: buyer.address,
    amount: 300_000_000n,
  });
  await pipe(
    await createDefaultTransaction(client, leader),
    (tx) => appendTransactionMessageInstruction(transferIx, tx),
    (tx) => signAndSendTransaction(client, tx)
  );

  // Mint a Collection NFT + child NFT linked to it. Leader is authority
  // and auto-verified creator on both. The child's metadata has
  // collection = {key: collectionMint, verified: true} — required by
  // `apply_community_share` check (2).
  console.log('▶ minting collection + child NFT...');
  const { collection, item } = await createDefaultNftInCollection({
    client,
    payer: leader,
    authority: leader,
    owner: leader.address,
  });
  const collectionMint = collection.mint;
  const collectionMetadata = collection.metadata;
  const mint = item.mint;
  console.log(`  collection  : ${collectionMint}`);
  console.log(`  child mint  : ${mint}`);

  // P1-1: seal collection metadata (is_mutable = false) so
  // `register_community_collection` accepts it.
  console.log('▶ sealing collection metadata...');
  const sealIx = getUpdateMetadataAccountV2Instruction({
    metadata: collectionMetadata,
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

  // Register the community collection. PDA seed uses the COLLECTION mint.
  console.log('▶ register_community_collection...');
  const [registration] = await findCommunityRegistrationPda(
    { collectionMint },
    { programAddress: PROGRAM_ADDRESS }
  );
  const registerIx = await getRegisterCommunityCollectionInstructionAsync(
    {
      registration,
      collectionMint,
      metadata: collectionMetadata,
      leader,
      leaderSnowchatId: snowchatIdBytes(),
      channelId: channelIdBytes(),
    },
    { programAddress: PROGRAM_ADDRESS }
  );
  await pipe(
    await createDefaultTransaction(client, leader),
    (tx) => appendTransactionMessageInstruction(registerIx, tx),
    (tx) => signAndSendTransaction(client, tx)
  );
  console.log(`  PDA         : ${registration}`);

  // List the NFT at 0.1 SOL. We derive listState explicitly because the
  // codama-generated listLegacy uses the IDL's empty PROGRAM_ADDRESS for
  // its internal PDA lookup; passing it as an explicit input bypasses that.
  console.log(`▶ list_legacy @ ${Number(LISTING_PRICE) / 1e9} SOL...`);
  const [listState] = await findListStatePda(
    { mint },
    { programAddress: PROGRAM_ADDRESS }
  );
  const listIx = await getListLegacyInstructionAsync(
    {
      owner: leader,
      mint,
      amount: LISTING_PRICE,
      listState,
      marketplaceProgram: PROGRAM_ADDRESS,
    },
    { programAddress: PROGRAM_ADDRESS }
  );
  await pipe(
    await createDefaultTransaction(client, leader),
    (tx) => appendTransactionMessageInstruction(listIx, tx),
    (tx) => signAndSendTransaction(client, tx)
  );
  const [feeVault] = await findFeeVaultPda({ address: listState });
  console.log(`  listState   : ${listState}`);
  console.log(`  feeVault    : ${feeVault}`);

  // Snapshot balances.
  const feeVaultBefore = BigInt(
    (await client.rpc.getBalance(feeVault).send()).value
  );
  console.log(`  feeVault(0) : ${feeVaultBefore} lamports`);

  // Buy with community accounts.
  console.log('▶ buy_legacy with community split...');
  const buyIx = await getBuyLegacyInstructionAsync(
    {
      owner: leader.address,
      payer: buyer,
      mint,
      maxAmount: LISTING_PRICE + LISTING_PRICE, // generous ceiling for royalty
      creators: [leader.address],
      communityRegistration: registration,
      leaderWallet: leader.address,
      listState,
      feeVault,
      marketplaceProgram: PROGRAM_ADDRESS,
    },
    { programAddress: PROGRAM_ADDRESS }
  );
  const buySig = await pipe(
    await createDefaultTransaction(client, buyer),
    (tx) => appendTransactionMessageInstruction(buyIx, tx),
    (tx) => signAndSendTransaction(client, tx)
  );
  console.log(`  tx          : ${buySig}`);
  console.log(
    `  explorer    : https://explorer.solana.com/tx/${buySig}?cluster=devnet`
  );

  // Verify fee split via the PDA counters (lamport-exact).
  console.log('▶ verifying fee split...');
  const reg = await fetchCommunityRegistration(client.rpc, registration);
  const expectedProto = expectedProtocolFee(LISTING_PRICE);
  const expectedShare = expectedLeaderShare(expectedProto);

  console.log(`  expected protocol_fee   : ${expectedProto} lamports`);
  console.log(`  expected leader_share   : ${expectedShare} lamports`);
  console.log(`  PDA cumulativeShare     : ${reg.data.cumulativeShareLamports}`);
  console.log(`  PDA tradeCount          : ${reg.data.tradeCount}`);

  if (reg.data.cumulativeShareLamports !== expectedShare) {
    throw new Error(
      `cumulativeShareLamports mismatch: got ${reg.data.cumulativeShareLamports}, expected ${expectedShare}`
    );
  }
  if (reg.data.tradeCount !== 1n) {
    throw new Error(`tradeCount mismatch: got ${reg.data.tradeCount}, expected 1`);
  }

  console.log('✅ buy-split E2E passed — leader share credited exactly as spec');
}

main().catch((err) => {
  console.error('❌ buy-split failed');
  console.error(err);
  process.exit(1);
});
