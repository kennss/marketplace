// @file        clients/js/test/community/register.test.ts
// @description SnowChat Community Fee Share — RegisterCommunityCollection
//              instruction integration tests. Covers happy path + the
//              Agent A/B-flagged validation failures that must be rejected
//              on-chain.
// @author      Kennt Kim
// @company     Calida Lab
// @created     2026-04-24
// @lastUpdated 2026-04-24

import {
  appendTransactionMessageInstruction,
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
  findCommunityRegistrationPda,
  getRegisterCommunityCollectionInstructionAsync,
  TENSOR_MARKETPLACE_ERROR__COMMUNITY_UPDATE_AUTHORITY_MISMATCH,
} from '../../src/index.js';
import { expectCustomError } from '../_common.js';
import {
  fetchRegistration,
  getCommunitySigners,
  makeChannelIdBytes,
  makeClient,
  makeSnowchatIdBytes,
  mintCommunityEligibleNft,
  registerCollection,
} from './_common.js';

test('register — happy path initialises PDA with snapshot', async (t) => {
  const client = makeClient();
  const { leader, payer } = await getCommunitySigners(client);
  const { mint, metadata } = await mintCommunityEligibleNft({
    client,
    payer,
    leader,
  });

  const snowchatId = makeSnowchatIdBytes();
  const channelId = makeChannelIdBytes();

  const registration = await registerCollection({
    client,
    leader,
    collectionMint: mint,
    metadata,
    leaderSnowchatId: snowchatId,
    channelId,
  });

  const fetched = await fetchRegistration(client, registration);

  t.like(fetched, {
    data: {
      version: 1,
      collectionMint: mint,
      leaderWallet: leader.address,
      cumulativeShareLamports: 0n,
      tradeCount: 0n,
    },
  });
  t.deepEqual(Array.from(fetched.data.leaderSnowchatId), snowchatId);
  t.deepEqual(
    Array.from(fetched.data.channelId),
    Array.from(channelId)
  );
  t.not(fetched.data.registeredAt, 0n);
  t.is(fetched.data.revokedAt.__option, 'None');
});

test('register — rejects when signer is not update_authority', async (t) => {
  const client = makeClient();
  const { leader, payer } = await getCommunitySigners(client);
  const impostor = await generateKeyPairSignerWithSol(client, ONE_SOL);

  const { mint, metadata } = await mintCommunityEligibleNft({
    client,
    payer,
    leader,
  });

  const [registration] = await findCommunityRegistrationPda({
    collectionMint: mint,
  });

  const ix = await getRegisterCommunityCollectionInstructionAsync({
    registration,
    collectionMint: mint,
    metadata,
    leader: impostor,
    leaderSnowchatId: makeSnowchatIdBytes(),
    channelId: makeChannelIdBytes(),
  });

  const promise = pipe(
    await createDefaultTransaction(client, impostor),
    (tx) => appendTransactionMessageInstruction(ix, tx),
    (tx) => signAndSendTransaction(client, tx)
  );

  await expectCustomError(
    t,
    promise,
    TENSOR_MARKETPLACE_ERROR__COMMUNITY_UPDATE_AUTHORITY_MISMATCH
  );
});

test('register — rejects duplicate registration (same collection_mint)', async (t) => {
  const client = makeClient();
  const { leader, payer } = await getCommunitySigners(client);
  const { mint, metadata } = await mintCommunityEligibleNft({
    client,
    payer,
    leader,
  });

  await registerCollection({
    client,
    leader,
    collectionMint: mint,
    metadata,
    leaderSnowchatId: makeSnowchatIdBytes(),
    channelId: makeChannelIdBytes(),
  });

  // Second attempt — PDA already exists, `init` fails with Anchor
  // constraint error (account already initialised).
  const [registration] = await findCommunityRegistrationPda({
    collectionMint: mint,
  });
  const ix = await getRegisterCommunityCollectionInstructionAsync({
    registration,
    collectionMint: mint,
    metadata,
    leader,
    leaderSnowchatId: makeSnowchatIdBytes('deadbeefcafebabe1234567890abcdef'),
    channelId: makeChannelIdBytes(),
  });

  await t.throwsAsync(
    pipe(
      await createDefaultTransaction(client, leader),
      (tx) => appendTransactionMessageInstruction(ix, tx),
      (tx) => signAndSendTransaction(client, tx)
    )
  );
});
