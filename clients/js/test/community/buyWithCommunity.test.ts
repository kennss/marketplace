// @file        clients/js/test/community/buyWithCommunity.test.ts
// @description SnowChat Community Fee Share — buy with / without community
//              registration, verifying fee split and the Phase B.5 audit
//              rejections (P0-B dust redirect, leader_wallet mismatch).
//              Uses `createDefaultNftInCollection` so `metadata.collection.verified`
//              is true, satisfying `apply_community_share` check (2).
// @author      Kennt Kim
// @company     Calida Lab
// @created     2026-04-24
// @lastUpdated 2026-04-24

import {
  appendTransactionMessageInstruction,
  fetchEncodedAccount,
  pipe,
} from '@solana/web3.js';
import {
  createDefaultTransaction,
  generateKeyPairSignerWithSol,
  ONE_SOL,
  signAndSendTransaction,
} from '@tensor-foundation/test-helpers';
import test from 'ava';
import {
  fetchCommunityRegistration,
  findCommunityRegistrationPda,
  findListStatePda,
  getBuyLegacyInstructionAsync,
  getListLegacyInstructionAsync,
  TENSOR_MARKETPLACE_ERROR__COMMUNITY_LEADER_MISMATCH,
} from '../../src/index.js';
import {
  BASIS_POINTS,
  BROKER_FEE_PCT,
  expectCustomError,
  HUNDRED_PCT,
  TAKER_FEE_BPS,
} from '../_common.js';
import { computeIx } from '../legacy/_common.js';
import {
  getCommunitySigners,
  LEADER_SHARE_BPS,
  makeChannelIdBytes,
  makeClient,
  makeSnowchatIdBytes,
  mintSealedCommunityPair,
  MIN_LEADER_SHARE_LAMPORTS,
  registerCollection,
} from './_common.js';

const LISTING_PRICE = 1_000_000_000n; // 1 SOL — yields leader_share = 2_500_000 lamports (well above dust).
const DUST_LISTING_PRICE = 100_000n; // 0.0001 SOL — yields leader_share = 250 lamports < MIN (1000) → dust redirect.

function expectedProtocolFee(price: bigint): bigint {
  const totalFee = (price * TAKER_FEE_BPS) / BASIS_POINTS;
  const brokerFee = (totalFee * BROKER_FEE_PCT) / HUNDRED_PCT;
  return totalFee - brokerFee;
}

function expectedLeaderShare(protocolFee: bigint): bigint {
  return (protocolFee * LEADER_SHARE_BPS) / BASIS_POINTS;
}

test('buy — community split sends 50% of protocol fee to leader', async (t) => {
  const client = makeClient();
  const { leader, buyer } = await getCommunitySigners(client);

  const {
    collectionMint,
    collectionMetadata,
    itemMint,
  } = await mintSealedCommunityPair({ client, leader });

  await registerCollection({
    client,
    leader,
    collectionMint,
    collectionMetadata,
    leaderSnowchatId: makeSnowchatIdBytes(),
    channelId: makeChannelIdBytes(),
  });
  const [registration] = await findCommunityRegistrationPda({ collectionMint });

  const listIx = await getListLegacyInstructionAsync({
    owner: leader,
    mint: itemMint,
    amount: LISTING_PRICE,
  });
  await pipe(
    await createDefaultTransaction(client, leader),
    (tx) => appendTransactionMessageInstruction(computeIx, tx),
    (tx) => appendTransactionMessageInstruction(listIx, tx),
    (tx) => signAndSendTransaction(client, tx)
  );

  const buyIx = await getBuyLegacyInstructionAsync({
    owner: leader.address,
    payer: buyer,
    mint: itemMint,
    maxAmount: LISTING_PRICE + LISTING_PRICE,
    creators: [leader.address],
    communityRegistration: registration,
    leaderWallet: leader.address,
  });
  await pipe(
    await createDefaultTransaction(client, buyer),
    (tx) => appendTransactionMessageInstruction(computeIx, tx),
    (tx) => appendTransactionMessageInstruction(buyIx, tx),
    (tx) => signAndSendTransaction(client, tx)
  );

  const protocolFee = expectedProtocolFee(LISTING_PRICE);
  const leaderShare = expectedLeaderShare(protocolFee);

  const reg = await fetchCommunityRegistration(client.rpc, registration);
  t.is(reg.data.cumulativeShareLamports, leaderShare);
  t.is(reg.data.tradeCount, 1n);
});

test('buy — dust redirect: leader_share < MIN_LEADER_SHARE_LAMPORTS merges to platform [P0-B]', async (t) => {
  const client = makeClient();
  const { leader, buyer } = await getCommunitySigners(client);

  const {
    collectionMint,
    collectionMetadata,
    itemMint,
  } = await mintSealedCommunityPair({ client, leader });

  await registerCollection({
    client,
    leader,
    collectionMint,
    collectionMetadata,
    leaderSnowchatId: makeSnowchatIdBytes(),
    channelId: makeChannelIdBytes(),
  });
  const [registration] = await findCommunityRegistrationPda({ collectionMint });

  const listIx = await getListLegacyInstructionAsync({
    owner: leader,
    mint: itemMint,
    amount: DUST_LISTING_PRICE,
  });
  await pipe(
    await createDefaultTransaction(client, leader),
    (tx) => appendTransactionMessageInstruction(computeIx, tx),
    (tx) => appendTransactionMessageInstruction(listIx, tx),
    (tx) => signAndSendTransaction(client, tx)
  );

  // Sanity-check our fixture: expected leader_share must actually be below MIN.
  const expected = expectedLeaderShare(expectedProtocolFee(DUST_LISTING_PRICE));
  t.true(
    expected < MIN_LEADER_SHARE_LAMPORTS,
    `fixture: expected leader_share ${expected} must be below MIN ${MIN_LEADER_SHARE_LAMPORTS}`
  );

  const buyIx = await getBuyLegacyInstructionAsync({
    owner: leader.address,
    payer: buyer,
    mint: itemMint,
    maxAmount: DUST_LISTING_PRICE + DUST_LISTING_PRICE,
    creators: [leader.address],
    communityRegistration: registration,
    leaderWallet: leader.address,
  });
  await pipe(
    await createDefaultTransaction(client, buyer),
    (tx) => appendTransactionMessageInstruction(computeIx, tx),
    (tx) => appendTransactionMessageInstruction(buyIx, tx),
    (tx) => signAndSendTransaction(client, tx)
  );

  // PDA counters must stay at zero — dust was merged into platform vault.
  const reg = await fetchCommunityRegistration(client.rpc, registration);
  t.is(reg.data.cumulativeShareLamports, 0n);
  t.is(reg.data.tradeCount, 0n);
});

test('buy — without community (baseline) matches upstream Tensor', async (t) => {
  const client = makeClient();
  const { leader, buyer } = await getCommunitySigners(client);

  const { itemMint } = await mintSealedCommunityPair({ client, leader });

  const listIx = await getListLegacyInstructionAsync({
    owner: leader,
    mint: itemMint,
    amount: LISTING_PRICE,
  });
  await pipe(
    await createDefaultTransaction(client, leader),
    (tx) => appendTransactionMessageInstruction(computeIx, tx),
    (tx) => appendTransactionMessageInstruction(listIx, tx),
    (tx) => signAndSendTransaction(client, tx)
  );

  const buyIx = await getBuyLegacyInstructionAsync({
    owner: leader.address,
    payer: buyer,
    mint: itemMint,
    maxAmount: LISTING_PRICE + LISTING_PRICE,
    creators: [leader.address],
  });
  await pipe(
    await createDefaultTransaction(client, buyer),
    (tx) => appendTransactionMessageInstruction(computeIx, tx),
    (tx) => appendTransactionMessageInstruction(buyIx, tx),
    (tx) => signAndSendTransaction(client, tx)
  );

  const [listing] = await findListStatePda({ mint: itemMint });
  t.false((await fetchEncodedAccount(client.rpc, listing)).exists);
});

test('buy — rejects when leader_wallet does not match registration', async (t) => {
  const client = makeClient();
  const { leader, buyer } = await getCommunitySigners(client);
  const attacker = await generateKeyPairSignerWithSol(client, ONE_SOL);

  const {
    collectionMint,
    collectionMetadata,
    itemMint,
  } = await mintSealedCommunityPair({ client, leader });

  await registerCollection({
    client,
    leader,
    collectionMint,
    collectionMetadata,
    leaderSnowchatId: makeSnowchatIdBytes(),
    channelId: makeChannelIdBytes(),
  });
  const [registration] = await findCommunityRegistrationPda({ collectionMint });

  const listIx = await getListLegacyInstructionAsync({
    owner: leader,
    mint: itemMint,
    amount: LISTING_PRICE,
  });
  await pipe(
    await createDefaultTransaction(client, leader),
    (tx) => appendTransactionMessageInstruction(computeIx, tx),
    (tx) => appendTransactionMessageInstruction(listIx, tx),
    (tx) => signAndSendTransaction(client, tx)
  );

  const buyIx = await getBuyLegacyInstructionAsync({
    owner: leader.address,
    payer: buyer,
    mint: itemMint,
    maxAmount: LISTING_PRICE + LISTING_PRICE,
    creators: [leader.address],
    communityRegistration: registration,
    leaderWallet: attacker.address,
  });

  const promise = pipe(
    await createDefaultTransaction(client, buyer),
    (tx) => appendTransactionMessageInstruction(computeIx, tx),
    (tx) => appendTransactionMessageInstruction(buyIx, tx),
    (tx) => signAndSendTransaction(client, tx)
  );

  await expectCustomError(
    t,
    promise,
    TENSOR_MARKETPLACE_ERROR__COMMUNITY_LEADER_MISMATCH
  );
});
