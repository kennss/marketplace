// @file        clients/js/test/community/revoke.test.ts
// @description SnowChat Community Fee Share — RevokeCommunityCollection
//              rejection tests. Happy-path (cooldown expired) requires a
//              validator warp not exposed by ava; devnet E2E handles that.
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
  getRevokeCommunityCollectionInstruction,
  TENSOR_MARKETPLACE_ERROR__COMMUNITY_COOLDOWN_ACTIVE,
  TENSOR_MARKETPLACE_ERROR__COMMUNITY_LEADER_MISMATCH,
} from '../../src/index.js';
import { expectCustomError } from '../_common.js';
import {
  getCommunitySigners,
  makeChannelIdBytes,
  makeClient,
  makeSnowchatIdBytes,
  mintSealedCommunityPair,
  registerCollection,
} from './_common.js';

test('revoke — rejects cooldown active (same-block after register)', async (t) => {
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
  const ix = getRevokeCommunityCollectionInstruction({
    registration,
    leader,
  });

  const promise = pipe(
    await createDefaultTransaction(client, leader),
    (tx) => appendTransactionMessageInstruction(ix, tx),
    (tx) => signAndSendTransaction(client, tx)
  );

  await expectCustomError(
    t,
    promise,
    TENSOR_MARKETPLACE_ERROR__COMMUNITY_COOLDOWN_ACTIVE
  );
});

test('revoke — rejects when non-leader signs', async (t) => {
  const client = makeClient();
  const { leader } = await getCommunitySigners(client);
  const impostor = await generateKeyPairSignerWithSol(client, ONE_SOL);
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
  const ix = getRevokeCommunityCollectionInstruction({
    registration,
    leader: impostor,
  });

  const promise = pipe(
    await createDefaultTransaction(client, impostor),
    (tx) => appendTransactionMessageInstruction(ix, tx),
    (tx) => signAndSendTransaction(client, tx)
  );

  await expectCustomError(
    t,
    promise,
    TENSOR_MARKETPLACE_ERROR__COMMUNITY_LEADER_MISMATCH
  );
});
