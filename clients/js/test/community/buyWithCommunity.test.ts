// @file        clients/js/test/community/buyWithCommunity.test.ts
// @description SnowChat Community Fee Share — buy with / without community
//              registration, verifying fee split. Tensor's protocol_fee
//              (50% of TAKER_FEE_BPS) is split 50/50 between the platform
//              fee_vault and the registered leader wallet when the buy
//              instruction supplies the optional community trio.
// @author      Kennt Kim
// @company     Calida Lab
// @created     2026-04-24
// @lastUpdated 2026-04-24

import {
  appendTransactionMessageInstruction,
  assertAccountExists,
  fetchEncodedAccount,
  pipe,
} from '@solana/web3.js';
import { createDefaultNft } from '@tensor-foundation/mpl-token-metadata';
import {
  createDefaultTransaction,
  generateKeyPairSignerWithSol,
  ONE_SOL,
  signAndSendTransaction,
} from '@tensor-foundation/test-helpers';
import test from 'ava';
import {
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
  registerCollection,
} from './_common.js';

const LISTING_PRICE = 1_000_000_000n; // 1 SOL

/**
 * Compute Tensor's protocol_fee given a listing amount. Mirrors on-chain
 * `calc_fees` output for the protocol portion (total - broker portion).
 */
function expectedProtocolFee(listingPrice: bigint): bigint {
  const totalFee = (listingPrice * TAKER_FEE_BPS) / BASIS_POINTS;
  const brokerFee = (totalFee * BROKER_FEE_PCT) / HUNDRED_PCT;
  return totalFee - brokerFee;
}

function expectedLeaderShare(protocolFee: bigint): bigint {
  return (protocolFee * LEADER_SHARE_BPS) / BASIS_POINTS;
}

test('buy — community split sends 50% of protocol fee to leader', async (t) => {
  const client = makeClient();
  const { leader, buyer, payer } = await getCommunitySigners(client);

  // Mint an NFT where leader is both update_authority AND verified creator,
  // owned by leader so leader can list it.
  const { mint, metadata } = await createDefaultNft({
    client,
    payer,
    authority: leader,
    owner: leader.address,
  });

  // Register community collection.
  await registerCollection({
    client,
    leader,
    collectionMint: mint,
    metadata,
    leaderSnowchatId: makeSnowchatIdBytes(),
    channelId: makeChannelIdBytes(),
  });
  const [registration] = await findCommunityRegistrationPda({
    collectionMint: mint,
  });

  // List the NFT.
  const listIx = await getListLegacyInstructionAsync({
    owner: leader,
    mint,
    amount: LISTING_PRICE,
  });
  await pipe(
    await createDefaultTransaction(client, leader),
    (tx) => appendTransactionMessageInstruction(computeIx, tx),
    (tx) => appendTransactionMessageInstruction(listIx, tx),
    (tx) => signAndSendTransaction(client, tx)
  );

  const [listing] = await findListStatePda({ mint });
  assertAccountExists(await fetchEncodedAccount(client.rpc, listing));

  const leaderBefore = BigInt(
    (await client.rpc.getBalance(leader.address).send()).value
  );

  // Buy with community accounts provided.
  const buyIx = await getBuyLegacyInstructionAsync({
    owner: leader.address,
    payer: buyer,
    mint,
    maxAmount: LISTING_PRICE + LISTING_PRICE, // generous ceiling for royalties
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

  const leaderAfter = BigInt(
    (await client.rpc.getBalance(leader.address).send()).value
  );

  // Leader wallet receives: listing amount (as seller) + protocol_fee/2
  // (as community leader) + full creator fee (as sole creator). We assert
  // the delta is at least amount + leader_share — a stricter exact-equals
  // check would need to subtract listing/rent refunds which leak noise.
  const protocolFee = expectedProtocolFee(LISTING_PRICE);
  const leaderShare = expectedLeaderShare(protocolFee);
  const delta = leaderAfter - leaderBefore;

  t.true(
    delta >= LISTING_PRICE + leaderShare,
    `leader delta=${delta} expected >= ${LISTING_PRICE + leaderShare}`
  );

  // Registration PDA's cumulative stats were incremented.
  const { fetchCommunityRegistration } = await import('../../src/index.js');
  const fetched = await fetchCommunityRegistration(client.rpc, registration);
  t.is(fetched.data.cumulativeShareLamports, leaderShare);
  t.is(fetched.data.tradeCount, 1n);
});

test('buy — without community (baseline) matches upstream Tensor', async (t) => {
  const client = makeClient();
  const { leader, buyer, payer } = await getCommunitySigners(client);

  const { mint } = await createDefaultNft({
    client,
    payer,
    authority: leader,
    owner: leader.address,
  });

  const listIx = await getListLegacyInstructionAsync({
    owner: leader,
    mint,
    amount: LISTING_PRICE,
  });
  await pipe(
    await createDefaultTransaction(client, leader),
    (tx) => appendTransactionMessageInstruction(computeIx, tx),
    (tx) => appendTransactionMessageInstruction(listIx, tx),
    (tx) => signAndSendTransaction(client, tx)
  );

  // Buy with NO community accounts (baseline behaviour).
  const buyIx = await getBuyLegacyInstructionAsync({
    owner: leader.address,
    payer: buyer,
    mint,
    maxAmount: LISTING_PRICE + LISTING_PRICE,
    creators: [leader.address],
  });
  await pipe(
    await createDefaultTransaction(client, buyer),
    (tx) => appendTransactionMessageInstruction(computeIx, tx),
    (tx) => appendTransactionMessageInstruction(buyIx, tx),
    (tx) => signAndSendTransaction(client, tx)
  );

  // Listing account is closed — trade completed.
  const [listing] = await findListStatePda({ mint });
  t.false((await fetchEncodedAccount(client.rpc, listing)).exists);
});

test('buy — rejects when leader_wallet does not match registration', async (t) => {
  const client = makeClient();
  const { leader, buyer, payer } = await getCommunitySigners(client);
  const attacker = await generateKeyPairSignerWithSol(client, ONE_SOL);

  const { mint, metadata } = await createDefaultNft({
    client,
    payer,
    authority: leader,
    owner: leader.address,
  });

  await registerCollection({
    client,
    leader,
    collectionMint: mint,
    metadata,
    leaderSnowchatId: makeSnowchatIdBytes(),
    channelId: makeChannelIdBytes(),
  });
  const [registration] = await findCommunityRegistrationPda({
    collectionMint: mint,
  });

  const listIx = await getListLegacyInstructionAsync({
    owner: leader,
    mint,
    amount: LISTING_PRICE,
  });
  await pipe(
    await createDefaultTransaction(client, leader),
    (tx) => appendTransactionMessageInstruction(computeIx, tx),
    (tx) => appendTransactionMessageInstruction(listIx, tx),
    (tx) => signAndSendTransaction(client, tx)
  );

  // Attacker passes registration but redirects leader_wallet to self.
  const buyIx = await getBuyLegacyInstructionAsync({
    owner: leader.address,
    payer: buyer,
    mint,
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
