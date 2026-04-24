// SPDX-License-Identifier: Apache-2.0

use crate::*;

/// Voluntary revocation of an active community registration. Can only be
/// invoked by the registered leader, and only after the 30-day cooldown has
/// elapsed (Agent B P1 S-3 — prevents quick rotation abuse).
///
/// Revocation is a soft delete — the PDA stays open, `revoked_at` is set,
/// and `cumulative_share_lamports` / `trade_count` are preserved for audit.
/// A separate admin instruction (not yet implemented) is required to hard
/// close and refund rent.
#[derive(Accounts)]
pub struct RevokeCommunityCollection<'info> {
    #[account(
        mut,
        seeds = [
            CommunityRegistration::SEED_PREFIX,
            registration.collection_mint.as_ref(),
        ],
        bump = registration.bump,
        constraint = registration.leader_wallet == leader.key() @ TcompError::CommunityLeaderMismatch,
    )]
    pub registration: Account<'info, CommunityRegistration>,

    /// Must match `registration.leader_wallet`.
    pub leader: Signer<'info>,
}

pub fn process_revoke_community_collection(
    ctx: Context<RevokeCommunityCollection>,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let registration = &mut ctx.accounts.registration;

    require!(
        registration.is_active(),
        TcompError::CommunityAlreadyRevoked,
    );

    let elapsed = now
        .checked_sub(registration.registered_at)
        .ok_or_else(|| error!(TcompError::ArithmeticError))?;
    require!(
        elapsed >= REVOKE_COOLDOWN_SECS,
        TcompError::CommunityCooldownActive,
    );

    registration.revoked_at = Some(now);
    registration.revoked_reason = revoke_reason::USER_REQUEST;

    emit!(CommunityRevokedEvent {
        collection_mint: registration.collection_mint,
        leader: registration.leader_wallet,
        revoked_at: now,
        cumulative_share_lamports: registration.cumulative_share_lamports,
        trade_count: registration.trade_count,
        reason: registration.revoked_reason,
    });

    Ok(())
}

#[event]
pub struct CommunityRevokedEvent {
    pub collection_mint: Pubkey,
    pub leader: Pubkey,
    pub revoked_at: i64,
    pub cumulative_share_lamports: u64,
    pub trade_count: u64,
    pub reason: u8,
}
