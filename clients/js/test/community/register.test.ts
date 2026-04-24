// @file        clients/js/test/community/register.test.ts
// @description SnowChat Community Fee Share — RegisterCommunityCollection
//              instruction integration tests. Covers happy path + the
//              Phase B.5 audit rejections (P0-D System-owned leader,
//              P1-1 sealed metadata).
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
  TENSOR_MARKETPLACE_ERROR__COMMUNITY_METADATA_MUTABLE,
  TENSOR_MARKETPLACE_ERROR__COMMUNITY_UPDATE_AUTHORITY_MISMATCH,
} from '../../src/index.js';
import { expectCustomError } from '../_common.js';
import {
  fetchRegistration,
  getCommunitySigners,
  makeChannelIdBytes,
  makeClient,
  makeSnowchatIdBytes,
  mintSealedCommunityPair,
  mintUnsealedCommunityPair,
  registerCollection,
} from './_common.js';

test('register — happy path initialises PDA with snapshot', async (t) => {
  const client = makeClient();
  const { leader } = await getCommunitySigners(client);
  const { collectionMint, collectionMetadata } = await mintSealedCommunityPair({
    client,
    leader,
  });

  const snowchatId = makeSnowchatIdBytes();
  const channelId = makeChannelIdBytes();

  const registration = await registerCollection({
    client,
    leader,
    collectionMint,
    collectionMetadata,
    leaderSnowchatId: snowchatId,
    channelId,
  });

  const fetched = await fetchRegistration(client, registration);

  t.like(fetched, {
    data: {
      version: 1,
      collectionMint,
      leaderWallet: leader.address,
      cumulativeShareLamports: 0n,
      tradeCount: 0n,
    },
  });
  t.deepEqual(Array.from(fetched.data.leaderSnowchatId), snowchatId);
  t.deepEqual(Array.from(fetched.data.channelId), Array.from(channelId));
  t.not(fetched.data.registeredAt, 0n);
  t.is(fetched.data.revokedAt.__option, 'None');
});

test('register — rejects when signer is not update_authority', async (t) => {
  const client = makeClient();
  const { leader } = await getCommunitySigners(client);
  const impostor = await generateKeyPairSignerWithSol(client, ONE_SOL);

  const { collectionMint, collectionMetadata } = await mintSealedCommunityPair({
    client,
    leader,
  });

  const [registration] = await findCommunityRegistrationPda({
    collectionMint,
  });
  const ix = await getRegisterCommunityCollectionInstructionAsync({
    registration,
    collectionMint,
    metadata: collectionMetadata,
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

test('register — rejects unsealed (is_mutable=true) collection metadata [P1-1]', async (t) => {
  const client = makeClient();
  const { leader } = await getCommunitySigners(client);
  const { collectionMint, collectionMetadata } = await mintUnsealedCommunityPair({
    client,
    leader,
  });

  const [registration] = await findCommunityRegistrationPda({ collectionMint });
  const ix = await getRegisterCommunityCollectionInstructionAsync({
    registration,
    collectionMint,
    metadata: collectionMetadata,
    leader,
    leaderSnowchatId: makeSnowchatIdBytes(),
    channelId: makeChannelIdBytes(),
  });

  const promise = pipe(
    await createDefaultTransaction(client, leader),
    (tx) => appendTransactionMessageInstruction(ix, tx),
    (tx) => signAndSendTransaction(client, tx)
  );

  await expectCustomError(
    t,
    promise,
    TENSOR_MARKETPLACE_ERROR__COMMUNITY_METADATA_MUTABLE
  );
});

test('register — rejects duplicate registration (same collection_mint)', async (t) => {
  const client = makeClient();
  const { leader } = await getCommunitySigners(client);
  const { collectionMint, collectionMetadata } = await mintSealedCommunityPair({
    client,
    leader,
  });

  await registerCollection({
    client,
    leader,
    collectionMint,
    collectionMetadata,
    leaderSnowchatId: makeSnowchatIdBytes(),
    channelId: makeChannelIdBytes(),
  });

  const [registration] = await findCommunityRegistrationPda({ collectionMint });
  const ix = await getRegisterCommunityCollectionInstructionAsync({
    registration,
    collectionMint,
    metadata: collectionMetadata,
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
