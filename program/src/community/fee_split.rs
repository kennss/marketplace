// SPDX-License-Identifier: Apache-2.0

use crate::*;
use mpl_token_metadata::accounts::Metadata;

/// Result of computing how the platform protocol fee should be split between
/// the SnowChat platform vault and the community leader.
///
/// `leader_account` is `None` when no registration is supplied OR the
/// registration has been revoked. In that case the entire `tcomp_fee` flows
/// to the platform vault and existing Tensor behavior is preserved bit-for-bit.
pub struct CommunityShareSplit<'info> {
    pub platform_share: u64,
    pub leader_share: u64,
    pub leader_account: Option<AccountInfo<'info>>,
}

/// Default 50/50 split — half of the protocol fee to the leader, half to the
/// platform vault. Designed to be configurable via a `ConfigSetting` PDA in
/// a future extension; v1 hardcodes it for simplicity.
pub const COMMUNITY_LEADER_SHARE_BPS: u16 = 5_000; // 50.00%

/// Compute the platform/leader split for the given protocol fee, applying
/// every cross-validation required by §15.6 of the spec:
///
///   1. registration is active (revoked_at is None)
///   2. registration.collection_mint matches metadata.collection.key
///   3. provided leader_wallet account key matches registration.leader_wallet
///   4. metadata.creators contains a verified entry whose address equals
///      registration.leader_wallet (defends against server-side leader_wallet
///      redirect attack — Agent B P1 S-2)
///   5. metadata account hash equals registration.metadata_hash (defends
///      against post-registration metadata mutation — Agent A P1-3 / S-3)
///
/// Caller is responsible for actually transferring `platform_share` and
/// `leader_share` lamports/tokens, and for incrementing `cumulative_share_lamports`
/// + `trade_count` on the registration mut-borrow after the leader transfer
/// succeeds.
pub fn apply_community_share<'info>(
    tcomp_fee: u64,
    metadata: &Metadata,
    metadata_account: &AccountInfo<'info>,
    registration: Option<&Account<'info, CommunityRegistration>>,
    leader_wallet: Option<AccountInfo<'info>>,
) -> Result<CommunityShareSplit<'info>> {
    let Some(reg) = registration else {
        // No registration → preserve existing Tensor behavior — entire
        // protocol fee to the platform vault.
        return Ok(CommunityShareSplit {
            platform_share: tcomp_fee,
            leader_share: 0,
            leader_account: None,
        });
    };

    // Schema sanity.
    require!(
        reg.version == COMMUNITY_REGISTRATION_VERSION,
        TcompError::CommunityWrongVersion,
    );

    // (1) active.
    require!(reg.is_active(), TcompError::CommunityRegistrationRevoked);

    // (2) collection mint match. metadata.collection is itself optional —
    // the listed NFT may be a standalone with no collection. Such NFTs are
    // ineligible for community share (no collection to register against).
    let collection = metadata
        .collection
        .as_ref()
        .ok_or_else(|| error!(TcompError::CommunityNoCollection))?;
    require!(
        reg.collection_mint == collection.key,
        TcompError::CommunityCollectionMismatch,
    );

    // (3) leader account presence + key match.
    let leader = leader_wallet.ok_or_else(|| error!(TcompError::CommunityLeaderAccountMissing))?;
    require!(
        leader.key() == reg.leader_wallet,
        TcompError::CommunityLeaderMismatch,
    );

    // (4) creators[] cross-check.
    let creators = metadata
        .creators
        .as_ref()
        .ok_or_else(|| error!(TcompError::CommunityNoCreators))?;
    require!(
        creators
            .iter()
            .any(|c| c.address == leader.key() && c.verified),
        TcompError::CommunityLeaderNotVerified,
    );

    // (5) metadata hash freshness.
    let metadata_data = metadata_account.try_borrow_data()?;
    let current_hash = anchor_lang::solana_program::hash::hash(&metadata_data).to_bytes();
    require!(
        current_hash == reg.metadata_hash,
        TcompError::CommunityMetadataHashMismatch,
    );
    drop(metadata_data); // release borrow before any other access.

    // 50/50 split with floor-rounding via bps math. Dust (rounding remainder)
    // stays on platform side — preserves Tensor's invariant that no lamport
    // is lost.
    let leader_share = (tcomp_fee as u128)
        .checked_mul(COMMUNITY_LEADER_SHARE_BPS as u128)
        .and_then(|v| v.checked_div(10_000))
        .and_then(|v| u64::try_from(v).ok())
        .ok_or_else(|| error!(TcompError::ArithmeticError))?;

    let platform_share = tcomp_fee
        .checked_sub(leader_share)
        .ok_or_else(|| error!(TcompError::ArithmeticError))?;

    Ok(CommunityShareSplit {
        platform_share,
        leader_share,
        leader_account: Some(leader),
    })
}

/// Increment cumulative stats on the registration after a successful leader
/// share transfer. Caller must have the mutable Account<CommunityRegistration>
/// reference.
pub fn record_share_distribution(
    registration: &mut Account<CommunityRegistration>,
    leader_share: u64,
) -> Result<()> {
    if leader_share == 0 {
        return Ok(());
    }
    registration.cumulative_share_lamports = registration
        .cumulative_share_lamports
        .checked_add(leader_share)
        .ok_or_else(|| error!(TcompError::ArithmeticError))?;
    registration.trade_count = registration
        .trade_count
        .checked_add(1)
        .ok_or_else(|| error!(TcompError::ArithmeticError))?;
    Ok(())
}
