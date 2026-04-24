use crate::*;

#[error_code]
pub enum TcompError {
    // Start at 6100 so we don't conflict with bubblegum & compression error codes.
    // Anchor adds 6000 to all error codes, so we start at 100.
    #[msg("arithmetic error")]
    ArithmeticError = 100,

    #[msg("expiry too large")]
    ExpiryTooLarge = 101,

    #[msg("bad owner")]
    BadOwner = 102,

    #[msg("bad list state")]
    BadListState = 103,

    #[msg("royalties pct must be between 0 and 100")]
    BadRoyaltiesPct = 104,

    #[msg("price mismatch")]
    PriceMismatch = 105,

    #[msg("creator mismatch")]
    CreatorMismatch = 106,

    #[msg("insufficient balance")]
    InsufficientBalance = 107,

    #[msg("bid has expired")]
    BidExpired = 108,

    #[msg("taker not allowed")]
    TakerNotAllowed = 109,

    #[msg("cannot pass bid field")]
    BadBidField = 110,

    #[msg("bid not yet expired")]
    BidNotYetExpired = 111,

    #[msg("bad margin")]
    BadMargin = 112,

    #[msg("wrong ix for bid target called")]
    WrongIxForBidTarget = 113,

    #[msg("wrong target id")]
    WrongTargetId = 114,

    #[msg("creator array missing first verified creator")]
    MissingFvc = 115,

    #[msg("metadata missing collection")]
    MissingCollection = 116,

    #[msg("cannot modify bid target, create a new bid")]
    CannotModifyTarget = 117,

    #[msg("target id and bid id must be the same for single bids")]
    TargetIdMustEqualBidId = 118,

    #[msg("currency not yet enabled")]
    CurrencyNotYetEnabled = 119,

    #[msg("maker broker not yet enabled")]
    MakerBrokerNotYetEnabled = 120,

    #[msg("optional royalties not yet enabled")]
    OptionalRoyaltiesNotYetEnabled = 121,

    #[msg("wrong state version")]
    WrongStateVersion = 122,

    #[msg("wrong field id")]
    WrongBidFieldId = 123,

    #[msg("broker mismatch")]
    BrokerMismatch = 124,

    #[msg("asset id mismatch")]
    AssetIdMismatch = 125,

    #[msg("listing has expired")]
    ListingExpired = 126,

    #[msg("listing not yet expired")]
    ListingNotYetExpired = 127,

    #[msg("bad quantity passed in")]
    BadQuantity = 128,

    #[msg("bid fully filled")]
    BidFullyFilled = 129,

    #[msg("bad whitelist")]
    BadWhitelist = 130,

    #[msg("forbidden collection")]
    ForbiddenCollection = 131,

    #[msg("bad cosigner")]
    BadCosigner = 132,

    #[msg("bad mint proof")]
    BadMintProof = 133,

    #[msg("Currency mismatch")]
    CurrencyMismatch = 134,

    #[msg("The bid balance was not emptied")]
    BidBalanceNotEmptied = 135,

    #[msg("Bad rent dest.")]
    BadRentDest = 136,

    #[msg("currency not yet whitelisted")]
    CurrencyNotYetWhitelisted = 137,

    #[msg("maker broker not yet whitelisted")]
    MakerBrokerNotYetWhitelisted = 138,

    #[msg("token record derivation is wrong")]
    WrongTokenRecordDerivation = 139,

    #[msg("invalid fee account")]
    InvalidFeeAccount = 140,

    #[msg("insufficient remaining accounts")]
    InsufficientRemainingAccounts = 141,

    #[msg("missing broker account")]
    MissingBroker = 142,

    #[msg("missing broker token account")]
    MissingBrokerTokenAccount = 143,

    #[msg("invalid token account")]
    InvalidTokenAccount = 144,

    #[msg("missing creator ATA")]
    MissingCreatorATA = 145,

    #[msg("No whitelist method provided")]
    MissingWhitelistMethod = 146,

    #[msg("Edition data is empty")]
    EditionDataEmpty = 147,

    #[msg("Invalid mint")]
    InvalidMint = 148,

    // ----------------------------------------- SnowChat Community Fee Share
    // Reserved range 200..=249 — leaves 149..=199 free for Tensor upstream
    // additions to minimise merge conflicts.

    #[msg("update authority does not match leader signer")]
    CommunityUpdateAuthorityMismatch = 200,

    #[msg("NFT metadata has no creators")]
    CommunityNoCreators = 201,

    #[msg("leader is not a verified creator on the metadata")]
    CommunityLeaderNotVerified = 202,

    #[msg("registration cooldown still active (30 days)")]
    CommunityCooldownActive = 203,

    #[msg("registration already revoked")]
    CommunityAlreadyRevoked = 204,

    #[msg("registration is revoked")]
    CommunityRegistrationRevoked = 205,

    #[msg("collection mint mismatch between registration and listing")]
    CommunityCollectionMismatch = 206,

    #[msg("leader wallet account is required when community registration provided")]
    CommunityLeaderAccountMissing = 207,

    #[msg("leader wallet does not match registration")]
    CommunityLeaderMismatch = 208,

    #[msg("metadata hash mismatch — collection updated since registration")]
    CommunityMetadataHashMismatch = 209,

    #[msg("NFT metadata has no collection link")]
    CommunityNoCollection = 210,

    #[msg("schema version mismatch on community registration")]
    CommunityWrongVersion = 211,

    #[msg("community leader wallet must be System-owned (regular SOL wallet)")]
    CommunityLeaderNotSystemOwned = 212,

    #[msg("community collection metadata must be sealed (is_mutable = false)")]
    CommunityMetadataMutable = 213,

    #[msg("community NFT collection membership must be verified")]
    CommunityCollectionNotVerified = 214,
}
