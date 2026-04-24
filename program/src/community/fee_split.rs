// SPDX-License-Identifier: Apache-2.0

use crate::*;
use anchor_lang::solana_program::system_program;
use mpl_token_metadata::accounts::Metadata;

/// Result of computing how the platform protocol fee should be split between
/// the SnowChat platform vault and the community leader.
///
/// `leader_account` is `None` when no registration is supplied, the
/// registration has been revoked, OR the computed leader_share fell below
/// `MIN_LEADER_SHARE_LAMPORTS` (dust redirect). In all three cases the entire
/// `tcomp_fee` flows to the platform vault and existing Tensor behavior is
/// preserved bit-for-bit.
pub struct CommunityShareSplit<'info> {
    pub platform_share: u64,
    pub leader_share: u64,
    pub leader_account: Option<AccountInfo<'info>>,
}

/// Default 50/50 split — half of the protocol fee to the leader, half to the
/// platform vault. Designed to be configurable via a `ConfigSetting` PDA in
/// a future extension; v1 hardcodes it for simplicity.
pub const COMMUNITY_LEADER_SHARE_BPS: u16 = 5_000; // 50.00%

/// Minimum leader_share that we will actually transfer. Below this threshold
/// the share merges into the platform vault instead — rent-dust safety per
/// Agent B P0-1. Prevents leaders with near-empty wallets from accumulating
/// sub-rent-exempt balances that are economically unusable (transfer tx fee
/// exceeds value), and eliminates an edge case where a fresh 0-balance leader
/// wallet could receive dust that leaves it below the rent-exempt floor.
/// 1_000 lamports = 0.000001 SOL — at TAKER_FEE_BPS=200 (2%) and
/// COMMUNITY_LEADER_SHARE_BPS=5000 this corresponds to NFT prices above
/// ~0.0001 SOL; below that the trade is economically dust anyway.
pub const MIN_LEADER_SHARE_LAMPORTS: u64 = 1_000;

/// Compute the platform/leader split for the given protocol fee, applying
/// every cross-validation required by §15.6 of the spec.
///
/// Active checks (§15.11 "2중 검증 + economic guards"):
///   1. registration is active (revoked_at is None)
///   2. registration.collection_mint matches metadata.collection.key
///      AND metadata.collection.verified (Metaplex collection verified bit)
///   3. provided leader_wallet account key matches registration.leader_wallet
///      AND leader_wallet is System-owned (regular SOL wallet, not a PDA of
///      another program) — Agent B P0-D defense
///   4. metadata.creators contains a verified entry whose address equals
///      registration.leader_wallet (defends against server-side leader_wallet
///      redirect attack — Agent B P1 S-2)
///   5. (removed — was: metadata_hash snapshot comparison. The original
///      implementation compared CHILD NFT metadata to COLLECTION metadata
///      hash, which is always unequal — a logical bug. The honest fix is to
///      wire a dedicated `collection_metadata` account through every buy
///      instruction, which is deferred. For now, (4) enforces the practical
///      invariant: leader must be a verified creator on the specific NFT.
///      See Agent A audit P1-1 for the residual risk: update_authority
///      compromise + `seller_fee_basis_points` mutation is not detected.
///      Mitigation: `register.rs` now requires `is_mutable == false` so
///      post-registration mutation is blocked at the Metaplex level.)
///
/// Economic guards:
///   - Dust redirect: `leader_share < MIN_LEADER_SHARE_LAMPORTS` → merge
///     into platform. (§P0-B mitigation)
///
/// Caller is responsible for actually transferring `platform_share` and
/// `leader_share` lamports/tokens via `transfer_lamports_checked` (which
/// skips the transfer if the destination would end below rent-exempt), and
/// for incrementing `cumulative_share_lamports` + `trade_count` on the
/// registration mut-borrow after the leader transfer succeeds.
///
/// **SOL vs SPL**: `cumulative_share_lamports` is SOL-only. SPL currency
/// flows must not call `record_share_distribution` (§P0-A). SPL aggregation
/// is off-chain via the `CommunityShareDistributed` event.
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

    // (2) collection mint match + verified flag. metadata.collection is
    // itself optional — the listed NFT may be a standalone with no
    // collection. Such NFTs are ineligible for community share.
    // The `verified` bit is Metaplex's attestation that the collection
    // NFT's update_authority signed this child's membership — without it
    // any NFT could falsely claim membership.
    let collection = metadata
        .collection
        .as_ref()
        .ok_or_else(|| error!(TcompError::CommunityNoCollection))?;
    require!(
        reg.collection_mint == collection.key,
        TcompError::CommunityCollectionMismatch,
    );
    require!(
        collection.verified,
        TcompError::CommunityCollectionNotVerified,
    );

    // (3) leader account presence + key match + System-owned.
    let leader = leader_wallet.ok_or_else(|| error!(TcompError::CommunityLeaderAccountMissing))?;
    require!(
        leader.key() == reg.leader_wallet,
        TcompError::CommunityLeaderMismatch,
    );
    // P0-D: leader must be a regular SOL wallet (System-owned). Blocks an
    // attacker from registering a PDA of another program as the leader and
    // using community payouts to corrupt that program's accounting.
    require!(
        leader.owner == &system_program::ID,
        TcompError::CommunityLeaderNotSystemOwned,
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

    // (5) removed — see module-level docstring.
    let _ = metadata_account;
    let _ = &reg.metadata_hash;

    // 50/50 split with floor-rounding via bps math. Dust (rounding remainder)
    // stays on platform side — preserves Tensor's invariant that no lamport
    // is lost.
    let leader_share_raw = (tcomp_fee as u128)
        .checked_mul(COMMUNITY_LEADER_SHARE_BPS as u128)
        .and_then(|v| v.checked_div(10_000))
        .and_then(|v| u64::try_from(v).ok())
        .ok_or_else(|| error!(TcompError::ArithmeticError))?;

    // P0-B: if leader_share would be dust, redirect to platform. See
    // MIN_LEADER_SHARE_LAMPORTS doc for rationale.
    if leader_share_raw < MIN_LEADER_SHARE_LAMPORTS {
        msg!(
            "community leader_share {} lamports below MIN {}; merging into platform vault",
            leader_share_raw,
            MIN_LEADER_SHARE_LAMPORTS
        );
        return Ok(CommunityShareSplit {
            platform_share: tcomp_fee,
            leader_share: 0,
            leader_account: None,
        });
    }

    let platform_share = tcomp_fee
        .checked_sub(leader_share_raw)
        .ok_or_else(|| error!(TcompError::ArithmeticError))?;

    Ok(CommunityShareSplit {
        platform_share,
        leader_share: leader_share_raw,
        leader_account: Some(leader),
    })
}

/// Increment cumulative stats on the registration after a successful leader
/// share transfer. Caller must have the mutable Account<CommunityRegistration>
/// reference.
///
/// **SOL-only**: `cumulative_share_lamports` is a `u64` in lamport units
/// (1e9 per SOL). SPL currency flows (USDC=1e6, TNSR=1e9, etc.) must NOT
/// call this helper — mixing units in the same counter would corrupt
/// monthly settlement and audit records. Off-chain indexers aggregate SPL
/// totals per-currency via the `CommunityShareDistributed` event emitted
/// by the buy/take_bid instructions.
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
