// SPDX-License-Identifier: Apache-2.0

use crate::*;
use anchor_spl::token_interface::Mint;
use mpl_token_metadata::accounts::Metadata;
use tensor_toolbox::token_metadata::assert_decode_metadata;

/// Register an NFT collection for community fee share. Caller must be the
/// metadata `update_authority` AND must appear as a `verified=true` entry in
/// `metadata.creators[]`.
#[derive(Accounts)]
pub struct RegisterCommunityCollection<'info> {
    /// Newly initialised PDA. Seed: [b"community_registration", collection_mint].
    /// Leader pays rent.
    #[account(
        init,
        payer = leader,
        space = CommunityRegistration::SIZE,
        seeds = [
            CommunityRegistration::SEED_PREFIX,
            collection_mint.key().as_ref(),
        ],
        bump,
    )]
    pub registration: Account<'info, CommunityRegistration>,

    /// The collection master mint being registered.
    pub collection_mint: Box<InterfaceAccount<'info, Mint>>,

    /// Metaplex metadata account for `collection_mint`. Validated by
    /// `assert_decode_metadata` and seeds-derived from collection_mint.
    /// CHECK: see assert_decode_metadata + seeds
    #[account(
        seeds = [
            mpl_token_metadata::accounts::Metadata::PREFIX,
            mpl_token_metadata::ID.as_ref(),
            collection_mint.key().as_ref(),
        ],
        seeds::program = mpl_token_metadata::ID,
        bump,
    )]
    pub metadata: UncheckedAccount<'info>,

    /// Community leader — receives community share, pays rent, signs.
    #[account(mut)]
    pub leader: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn process_register_community_collection(
    ctx: Context<RegisterCommunityCollection>,
    leader_snowchat_id: [u8; 36],
    channel_id: [u8; 32],
) -> Result<()> {
    let collection_key = ctx.accounts.collection_mint.key();
    let metadata: Metadata = assert_decode_metadata(&collection_key, &ctx.accounts.metadata)?;

    // updateAuthority must equal the signer (Agent B P1 S-3).
    require!(
        metadata.update_authority == ctx.accounts.leader.key(),
        TcompError::CommunityUpdateAuthorityMismatch,
    );

    // Leader must already be a verified creator on the metadata.
    let creators = metadata
        .creators
        .as_ref()
        .ok_or_else(|| error!(TcompError::CommunityNoCreators))?;
    require!(
        creators
            .iter()
            .any(|c| c.address == ctx.accounts.leader.key() && c.verified),
        TcompError::CommunityLeaderNotVerified,
    );

    // Snapshot metadata hash for later mutation detection.
    let metadata_data = ctx.accounts.metadata.try_borrow_data()?;
    let metadata_hash = anchor_lang::solana_program::hash::hash(&metadata_data).to_bytes();
    drop(metadata_data);

    // Initialise PDA fields.
    let registration = &mut ctx.accounts.registration;
    registration.version = COMMUNITY_REGISTRATION_VERSION;
    registration.bump = ctx.bumps.registration;
    registration.collection_mint = collection_key;
    registration.leader_wallet = ctx.accounts.leader.key();
    registration.leader_snowchat_id = leader_snowchat_id;
    registration.channel_id = channel_id;
    registration.metadata_hash = metadata_hash;
    registration.registered_at = Clock::get()?.unix_timestamp;
    registration.revoked_at = None;
    registration.revoked_reason = revoke_reason::USER_REQUEST;
    registration.cumulative_share_lamports = 0;
    registration.trade_count = 0;
    registration._reserved = [0u8; COMMUNITY_REGISTRATION_RESERVED];

    emit!(CommunityRegisteredEvent {
        collection_mint: registration.collection_mint,
        leader: registration.leader_wallet,
        registered_at: registration.registered_at,
    });

    Ok(())
}

#[event]
pub struct CommunityRegisteredEvent {
    pub collection_mint: Pubkey,
    pub leader: Pubkey,
    pub registered_at: i64,
}
