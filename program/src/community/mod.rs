// SPDX-License-Identifier: Apache-2.0
//
// SnowChat Community Fee Share extension to the Tensor marketplace program.
// All files under `src/community/` are SnowChat additions; the Tensor base
// remains under Apache-2.0 with original authorship preserved.
//
// Spec: Documentation/Dev-plan2/Wallet-V2-Phase2-Community-Fee-Share.md §15
//
// This module:
//  - state.rs       CommunityRegistration PDA layout + constants
//  - register.rs    RegisterCommunityCollection instruction
//  - revoke.rs      RevokeCommunityCollection instruction
//  - fee_split.rs   apply_community_share helper used by Buy/TakeBid handlers
//
// Error variants live in the top-level `error::TcompError` enum (codes 200..)
// to keep a single error namespace per Anchor program (Anchor 0.29 limit).

pub mod fee_split;
pub mod register;
pub mod revoke;
pub mod state;

pub use fee_split::*;
pub use register::*;
pub use revoke::*;
pub use state::*;
