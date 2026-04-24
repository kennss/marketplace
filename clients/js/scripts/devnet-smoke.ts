// @file        clients/js/scripts/devnet-smoke.ts
// @description Devnet smoke test for SnowChat Community Fee Share fork.
//              Mints a Metaplex NFT where our wallet is update_authority +
//              verified creator, then calls register_community_collection
//              against the deployed program and verifies the PDA state.
// @author      Kennt Kim
// @company     Calida Lab
// @created     2026-04-24
// @lastUpdated 2026-04-24
//
// Run: cd clients/js && pnpm tsx scripts/devnet-smoke.ts
//
// Pre-reqs:
// - ~/.config/solana/id.json funded on devnet (~2 SOL covers mint + PDA rent)
// - Program deployed at PROGRAM_ADDRESS below

import {
  address,
  Address,
  appendTransactionMessageInstruction,
  pipe,
} from '@solana/web3.js';
import {
  createDefaultNft,
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
  getRegisterCommunityCollectionInstructionAsync,
} from '../src/index.js';

const PROGRAM_ADDRESS = address('BJMvy7BcwsTXyHP6Ua7ekeE7DUoN2i9KrQyEhgqVJ32z');
const DEVNET_RPC = 'https://api.devnet.solana.com';
const KEYPAIR_PATH = join(homedir(), '.config', 'solana', 'id.json');

const SNOWCHAT_ID = 'snow0123456789abcdef0123456789abcdef';
const CHANNEL_SEED = 'SnowChatDevnetSmokeCh01234567890';

async function loadKeypair() {
  const raw = readFileSync(KEYPAIR_PATH, 'utf-8');
  const bytes = Uint8Array.from(JSON.parse(raw));
  return createKeyPairSigner(bytes);
}

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

async function main() {
  console.log(`▶ devnet-smoke starting on ${DEVNET_RPC}`);
  console.log(`  program: ${PROGRAM_ADDRESS}`);

  const leader = await loadKeypair();
  console.log(`  wallet : ${leader.address}`);

  const client = createDefaultSolanaClient(DEVNET_RPC);

  const balance = await client.rpc.getBalance(leader.address).send();
  console.log(`  balance: ${Number(balance.value) / 1e9} SOL`);
  if (balance.value < 500_000_000n) {
    throw new Error('Need at least 0.5 SOL for NFT mint + registration');
  }

  // Mint an NFT with leader as authority (auto-verified creator).
  console.log('▶ minting NFT (Metaplex Token Metadata)...');
  const { mint, metadata } = await createDefaultNft({
    client,
    payer: leader,
    authority: leader,
    owner: leader.address,
  });
  console.log(`  mint    : ${mint}`);
  console.log(`  metadata: ${metadata}`);

  // P1-1: seal metadata so `register_community_collection` accepts it.
  console.log('▶ sealing collection metadata (is_mutable = false)...');
  const sealIx = getUpdateMetadataAccountV2Instruction({
    metadata,
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

  // Derive registration PDA (programAddress override because the
  // generated client has an empty default address in this IDL revision).
  const [registration] = await findCommunityRegistrationPda(
    { collectionMint: mint },
    { programAddress: PROGRAM_ADDRESS }
  );
  console.log(`  PDA     : ${registration}`);

  // Build the register instruction against our deployed program.
  console.log('▶ sending register_community_collection tx...');
  const ix = await getRegisterCommunityCollectionInstructionAsync(
    {
      registration,
      collectionMint: mint,
      metadata,
      leader,
      leaderSnowchatId: snowchatIdBytes(),
      channelId: channelIdBytes(),
    },
    { programAddress: PROGRAM_ADDRESS }
  );

  const sig = await pipe(
    await createDefaultTransaction(client, leader),
    (tx) => appendTransactionMessageInstruction(ix, tx),
    (tx) => signAndSendTransaction(client, tx)
  );
  console.log(`  tx      : ${sig}`);
  console.log(
    `  explorer: https://explorer.solana.com/tx/${sig}?cluster=devnet`
  );

  // Fetch and print the registration PDA state.
  console.log('▶ verifying CommunityRegistration PDA state...');
  const reg = await fetchCommunityRegistration(client.rpc, registration);
  console.log(`  version                 : ${reg.data.version}`);
  console.log(`  collectionMint          : ${reg.data.collectionMint}`);
  console.log(`  leaderWallet            : ${reg.data.leaderWallet}`);
  console.log(`  registeredAt            : ${reg.data.registeredAt}`);
  console.log(
    `  revokedAt               : ${JSON.stringify(reg.data.revokedAt)}`
  );
  console.log(
    `  cumulativeShareLamports : ${reg.data.cumulativeShareLamports}`
  );
  console.log(`  tradeCount              : ${reg.data.tradeCount}`);

  if (reg.data.version !== 1) throw new Error('version mismatch');
  if (reg.data.collectionMint !== mint) throw new Error('collection mismatch');
  if (reg.data.leaderWallet !== leader.address) throw new Error('leader mismatch');

  console.log('✅ devnet smoke test passed');
}

main().catch((err) => {
  console.error('❌ smoke test failed');
  console.error(err);
  process.exit(1);
});
