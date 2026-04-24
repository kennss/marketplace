// SPDX-License-Identifier: Apache-2.0
//
// SnowChat Community Fee Share extension to Tensor marketplace.
// See: Documentation/Dev-plan2/Wallet-V2-Phase2-Community-Fee-Share.md §15.

use crate::*;

/// Reserved range for community fields if we need to extend without migration.
pub const COMMUNITY_REGISTRATION_RESERVED: usize = 64;

/// On-chain registration linking an NFT collection to a community leader's
/// wallet. The `apply_community_share` fee-split helper consults this PDA
/// (passed as an optional account on every Buy/TakeBid instruction) and routes
/// half of the platform fee to the leader.
///
/// Seed: `[b"community_registration", collection_mint]` — one registration
/// per collection. Channel↔collection mapping is owned by the off-chain server
/// (`community_collection_registrations` table) and is not authoritative for
/// fee routing — the on-chain PDA is the sole source of truth.
#[account]
#[derive(InitSpace)]
pub struct CommunityRegistration {
    /// Schema version. Bump on layout-incompatible changes.
    pub version: u8,
    /// PDA bump.
    pub bump: u8,

    /// NFT collection master mint (PDA seed).
    pub collection_mint: Pubkey,

    /// Verified leader wallet — recipient of community share. Must match
    /// `metadata.update_authority` at registration time AND must appear as
    /// a `verified=true` entry in `metadata.creators[]` on every trade
    /// (cross-checked in `apply_community_share`).
    pub leader_wallet: Pubkey,

    /// SnowChat ID snapshot for off-chain audit trail.
    /// Format: ASCII "snow" + 32 hex chars = 36 bytes.
    pub leader_snowchat_id: [u8; 36],

    /// SnowChat channel id snapshot (off-chain index helper). Server side
    /// enforces 1 collection per channel via DB unique constraint; on-chain
    /// only stores for emit/audit.
    pub channel_id: [u8; 32],

    /// SHA-256 hash of the metadata account at registration time. Re-checked
    /// on every trade to detect post-registration mutation
    /// (Agent A P1-3 / Agent B P1 S-3 — metadata mutation attack).
    pub metadata_hash: [u8; 32],

    /// unix timestamp.
    pub registered_at: i64,

    /// None = active. Some(ts) = revoked at ts. Soft delete preserves
    /// cumulative stats + audit trail.
    pub revoked_at: Option<i64>,

    /// Reason code for revocation. Enum variants:
    ///   0 = user_request
    ///   1 = metadata_mismatch (auto-suspended on hash mismatch)
    ///   2 = admin_action
    ///   3 = cooldown_violation
    ///   4 = update_authority_changed
    pub revoked_reason: u8,

    /// Lamports of community share routed cumulative. Atomic increment on
    /// every successful Buy/TakeBid. Source of truth for off-chain dashboard
    /// + monthly settlement (Agent A P1-5).
    pub cumulative_share_lamports: u64,

    /// Number of trades that routed share to this registration.
    pub trade_count: u64,

    /// Reserved for forward compatibility (e.g. tier-based split ratios,
    /// per-currency cumulative tracking). Zero-filled at init.
    pub _reserved: [u8; COMMUNITY_REGISTRATION_RESERVED],
}

impl CommunityRegistration {
    pub const SIZE: usize = DISCRIMINATOR_SIZE + Self::INIT_SPACE;

    pub const SEED_PREFIX: &'static [u8] = b"community_registration";

    /// Compute the PDA seeds used for `init` and signing CPIs (rare — leader
    /// signs directly for register/revoke; only fee distribution from this PDA
    /// would need signing, which is not currently implemented).
    pub fn seeds<'a>(&'a self, collection_mint: &'a Pubkey) -> [&'a [u8]; 3] {
        // The bump is stored as a u8; callers reconstruct the &[u8] slice
        // using a stack-local `[u8; 1]` to satisfy lifetime constraints.
        // For ergonomic CPI signing we expose a 3-element seed array; the
        // bump byte must be passed as a borrowed slice by the caller.
        [
            Self::SEED_PREFIX,
            collection_mint.as_ref(),
            // bump is appended by the caller as &[self.bump]
            &[],
        ]
    }

    /// True when registration is active (not revoked).
    pub fn is_active(&self) -> bool {
        self.revoked_at.is_none()
    }
}

/// Schema version emitted in new registrations. Bump when layout changes.
pub const COMMUNITY_REGISTRATION_VERSION: u8 = 1;

/// Reason codes for revoked_reason field.
pub mod revoke_reason {
    pub const USER_REQUEST: u8 = 0;
    pub const METADATA_MISMATCH: u8 = 1;
    pub const ADMIN_ACTION: u8 = 2;
    pub const COOLDOWN_VIOLATION: u8 = 3;
    pub const UPDATE_AUTHORITY_CHANGED: u8 = 4;
}

/// 30-day cooldown enforced before voluntary revocation (Agent B P1 S-3).
pub const REVOKE_COOLDOWN_SECS: i64 = 30 * 24 * 60 * 60;
