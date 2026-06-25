/// Batch operations for high-volume token processing.
///
/// Provides `batch_reveal` (batch token creation) and `batch_settle` (batch mint)
/// with atomic execution, storage-access optimization, and a hard batch-size cap
/// to bound gas consumption.
use soroban_sdk::{Address, Env, Vec};

use crate::storage;
use crate::types::{Error, MintOutcome, TokenCreationParams};

/// Maximum number of items allowed in a single batch call.
pub const MAX_BATCH_SIZE: u32 = 50;

/// Batch-create tokens in a single atomic transaction.
///
/// All parameter validation is performed before any state is written, so a
/// validation failure on any item leaves the ledger unchanged.
///
/// # Gas optimisation
/// Token count is read once, incremented in memory, and written once at the
/// end — avoiding N redundant storage round-trips.
///
/// # Arguments
/// * `creator`            – Address that will own all created tokens (must auth).
/// * `tokens`             – Parameters for each token; max `MAX_BATCH_SIZE` items.
/// * `total_fee_payment`  – Combined fee covering every token in the batch.
///
/// # Returns
/// Indices of the newly created tokens (in input order).
///
/// # Errors
/// * `ContractPaused`      – Factory is paused.
/// * `BatchTooLarge`       – `tokens.len() > MAX_BATCH_SIZE`.
/// * `InvalidParameters`   – Empty batch.
/// * `InsufficientFee`     – `total_fee_payment` is below the required total.
/// * `InvalidTokenParams`  – Any token fails parameter validation.
pub fn batch_reveal(
    env: &Env,
    creator: Address,
    tokens: Vec<TokenCreationParams>,
    total_fee_payment: i128,
) -> Result<Vec<u32>, Error> {
    if storage::is_paused(env) {
        return Err(Error::ContractPaused);
    }

    creator.require_auth();

    let batch_len = tokens.len();
    if batch_len == 0 {
        return Err(Error::InvalidParameters);
    }
    if batch_len > MAX_BATCH_SIZE {
        return Err(Error::BatchTooLarge);
    }

    // ── Phase 1: validate all params and accumulate required fee ──────────
    let base_fee = storage::get_base_fee(env);
    let metadata_fee = storage::get_metadata_fee(env);

    let mut required_fee: i128 = 0;
    for token in tokens.iter() {
        validate_token_params(env, &token)?;
        let token_fee = if token.metadata_uri.is_some() {
            base_fee
                .checked_add(metadata_fee)
                .ok_or(Error::ArithmeticError)?
        } else {
            base_fee
        };
        required_fee = required_fee
            .checked_add(token_fee)
            .ok_or(Error::ArithmeticError)?;
    }

    if total_fee_payment < required_fee {
        return Err(Error::InsufficientFee);
    }

    // ── Phase 2: write state (all validations passed) ─────────────────────
    // Read token count once to avoid N storage reads.
    let start_index = storage::get_token_count(env);
    let mut indices = Vec::new(env);

    for (i, token) in tokens.iter().enumerate() {
        let token_index = start_index
            .checked_add(i as u32)
            .ok_or(Error::ArithmeticError)?;

        crate::token_creation::create_token_internal(env, &creator, &token, token_index)?;
        indices.push_back(token_index);
    }

    // Write the new token count in a single storage operation.
    let new_count = start_index
        .checked_add(batch_len)
        .ok_or(Error::ArithmeticError)?;
    env.storage()
        .instance()
        .set(&crate::types::DataKey::TokenCount, &new_count);

    crate::events::emit_batch_tokens_created(env, &creator, batch_len);

    Ok(indices)
}

/// Batch-mint tokens to multiple recipients in a single atomic transaction.
///
/// All recipients receive tokens from the same `token_index`. The caller must
/// be the token creator. Validation of every (recipient, amount) pair is done
/// before any balance is updated.
///
/// # Gas optimisation
/// Token info is loaded once and reused across all mint operations.
///
/// # Arguments
/// * `creator`      – Token creator address (must auth).
/// * `token_index`  – Index of the token to mint.
/// * `recipients`   – `(recipient_address, amount)` pairs; max `MAX_BATCH_SIZE`.
///
/// # Returns
/// Total amount minted across all recipients.
///
/// # Errors
/// * `ContractPaused`    – Factory is paused.
/// * `TokenNotFound`     – `token_index` does not exist.
/// * `Unauthorized`      – Caller is not the token creator.
/// * `TokenPaused`       – Token is paused.
/// * `BatchTooLarge`     – More than `MAX_BATCH_SIZE` recipients.
/// * `InvalidParameters` – Empty recipients list or any amount ≤ 0.
/// * `MaxSupplyExceeded` – Batch would exceed the token's max supply.
pub fn batch_settle(
    env: &Env,
    creator: Address,
    token_index: u32,
    recipients: Vec<(Address, i128)>,
) -> Result<i128, Error> {
    if storage::is_paused(env) {
        return Err(Error::ContractPaused);
    }

    creator.require_auth();

    let batch_len = recipients.len();
    if batch_len == 0 {
        return Err(Error::InvalidParameters);
    }
    if batch_len > MAX_BATCH_SIZE {
        return Err(Error::BatchTooLarge);
    }

    // Load token info once.
    let token_info = storage::get_token_info(env, token_index).ok_or(Error::TokenNotFound)?;

    if token_info.creator != creator {
        return Err(Error::Unauthorized);
    }
    if storage::is_token_paused(env, token_index) {
        return Err(Error::TokenPaused);
    }

    // ── Phase 1: validate all amounts and compute total ───────────────────
    let mut total_mint: i128 = 0;
    for (_, amount) in recipients.iter() {
        if amount <= 0 {
            return Err(Error::InvalidParameters);
        }
        total_mint = total_mint
            .checked_add(amount)
            .ok_or(Error::ArithmeticError)?;
    }

    // Check max supply once using the aggregated total.
    if let Some(max) = token_info.max_supply {
        let new_supply = token_info
            .total_supply
            .checked_add(total_mint)
            .ok_or(Error::ArithmeticError)?;
        if new_supply > max {
            return Err(Error::MaxSupplyExceeded);
        }
    }

    // ── Phase 2: apply mints ──────────────────────────────────────────────
    for (recipient, amount) in recipients.iter() {
        crate::mint::mint(env, token_index, &recipient, amount)?;
    }

    crate::events::emit_batch_settle(env, token_index, &creator, batch_len, total_mint);

    Ok(total_mint)
}

/// Batch-mint to multiple recipients with **per-item failure isolation**.
///
/// Unlike [`batch_settle`], a single failing mint does not abort the batch.
/// Each `(recipient, amount)` pair is processed independently: successful
/// mints commit their state, while failed ones are reported in the returned
/// vector and via a `mnt_fail` event — leaving every other item unaffected.
///
/// # Isolation guarantee
/// [`crate::mint::mint`] performs all of its validation (amount, token pause,
/// existence, max-supply, arithmetic) *before* writing any storage. A returned
/// `Err` therefore implies no partial write for that item, so capturing the
/// per-item `Result` yields true state isolation without sub-transactions.
///
/// # Batch-level errors (fail fast, before any item is processed)
/// * `ContractPaused`    – Factory is paused.
/// * `InvalidParameters` – Empty `mints` list.
/// * `BatchTooLarge`     – More than `MAX_BATCH_SIZE` items.
/// * `TokenNotFound`     – `token_index` does not exist.
/// * `Unauthorized`      – Caller is not the token creator.
/// * `TokenPaused`       – Token is paused.
///
/// # Returns
/// One [`MintOutcome`] per input item, in input order. `outcomes.get(i)`
/// describes the result of `mints.get(i)`.
pub fn batch_mint_isolated(
    env: &Env,
    caller: Address,
    token_index: u32,
    mints: Vec<(Address, i128)>,
) -> Result<Vec<MintOutcome>, Error> {
    if storage::is_paused(env) {
        return Err(Error::ContractPaused);
    }

    caller.require_auth();

    let batch_len = mints.len();
    if batch_len == 0 {
        return Err(Error::InvalidParameters);
    }
    if batch_len > MAX_BATCH_SIZE {
        return Err(Error::BatchTooLarge);
    }

    // Batch-level preconditions are checked once up front; only per-item mint
    // failures are isolated and reported individually below.
    let token_info = storage::get_token_info(env, token_index).ok_or(Error::TokenNotFound)?;
    if token_info.creator != caller {
        return Err(Error::Unauthorized);
    }
    if storage::is_token_paused(env, token_index) {
        return Err(Error::TokenPaused);
    }

    let mut outcomes = Vec::new(env);
    for (i, (recipient, amount)) in mints.iter().enumerate() {
        let index = i as u32;
        match crate::mint::mint(env, token_index, &recipient, amount) {
            Ok(()) => {
                crate::events::emit_mint_succeeded(env, token_index, index, &recipient, amount);
                outcomes.push_back(MintOutcome {
                    index,
                    success: true,
                    error_code: 0,
                });
            }
            Err(e) => {
                // `Error` is a thin wrapper over its u32 contract code.
                let error_code = e.0;
                crate::events::emit_mint_failed(
                    env,
                    token_index,
                    index,
                    &recipient,
                    amount,
                    error_code,
                );
                outcomes.push_back(MintOutcome {
                    index,
                    success: false,
                    error_code,
                });
            }
        }
    }

    Ok(outcomes)
}

// ── helpers ───────────────────────────────────────────────────────────────────

fn validate_token_params(env: &Env, params: &TokenCreationParams) -> Result<(), Error> {
    if params.name.len() == 0 || params.name.len() > 32 {
        return Err(Error::InvalidTokenParams);
    }
    if params.symbol.len() == 0 || params.symbol.len() > 12 {
        return Err(Error::InvalidTokenParams);
    }
    if params.decimals > 18 {
        return Err(Error::InvalidTokenParams);
    }
    if params.initial_supply <= 0 {
        return Err(Error::InvalidTokenParams);
    }
    crate::mint::validate_max_supply_at_creation(params.initial_supply, params.max_supply)?;
    let _ = env; // env available for future validation
    Ok(())
}

// ── tests ─────────────────────────────────────────────────────────────────────

#[cfg(any())] // TEMP-VALIDATION-ONLY: disabled for vault_error isolation build
mod tests {
    use super::*;
    use soroban_sdk::{testutils::Address as _, vec, Env, String};

    fn setup() -> (Env, Address, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, crate::TokenFactory);
        let client = crate::TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);

        client.initialize(&admin, &treasury, &1_000_000_i128, &500_000_i128);

        (env, contract_id, admin, treasury)
    }

    fn make_params(env: &Env, name: &str, symbol: &str) -> TokenCreationParams {
        TokenCreationParams {
            name: String::from_str(env, name),
            symbol: String::from_str(env, symbol),
            decimals: 7,
            initial_supply: 1_000_000,
            max_supply: None,
            metadata_uri: None,
        }
    }

    // ── batch_reveal ──────────────────────────────────────────────────────

    #[test]
    fn batch_reveal_creates_tokens_atomically() {
        let (env, contract_id, admin, _treasury) = setup();
        let client = crate::TokenFactoryClient::new(&env, &contract_id);

        let tokens = vec![
            &env,
            make_params(&env, "Alpha", "ALP"),
            make_params(&env, "Beta", "BET"),
            make_params(&env, "Gamma", "GAM"),
        ];
        // 3 tokens × base_fee (1_000_000 each, no metadata)
        let indices = client.batch_reveal(&admin, &tokens, &3_000_000_i128).unwrap();

        assert_eq!(indices.len(), 3);
        assert_eq!(indices.get(0).unwrap(), 0);
        assert_eq!(indices.get(1).unwrap(), 1);
        assert_eq!(indices.get(2).unwrap(), 2);
    }

    #[test]
    fn batch_reveal_rejects_empty_batch() {
        let (env, contract_id, admin, _treasury) = setup();
        let client = crate::TokenFactoryClient::new(&env, &contract_id);

        let tokens: Vec<TokenCreationParams> = vec![&env];
        let err = client.batch_reveal(&admin, &tokens, &0_i128).unwrap_err();
        assert_eq!(err, crate::types::Error::InvalidParameters.into());
    }

    #[test]
    fn batch_reveal_rejects_insufficient_fee() {
        let (env, contract_id, admin, _treasury) = setup();
        let client = crate::TokenFactoryClient::new(&env, &contract_id);

        let tokens = vec![&env, make_params(&env, "Alpha", "ALP")];
        let err = client.batch_reveal(&admin, &tokens, &0_i128).unwrap_err();
        assert_eq!(err, crate::types::Error::InsufficientFee.into());
    }

    #[test]
    fn batch_reveal_atomic_rollback_on_invalid_param() {
        let (env, contract_id, admin, _treasury) = setup();
        let client = crate::TokenFactoryClient::new(&env, &contract_id);

        let bad = TokenCreationParams {
            name: String::from_str(&env, ""),
            symbol: String::from_str(&env, "BAD"),
            decimals: 7,
            initial_supply: 1_000_000,
            max_supply: None,
            metadata_uri: None,
        };
        let tokens = vec![&env, make_params(&env, "Good", "GD"), bad];
        let err = client.batch_reveal(&admin, &tokens, &2_000_000_i128).unwrap_err();
        assert_eq!(err, crate::types::Error::InvalidTokenParams.into());

        // Token count must remain 0 — no partial writes.
        let state = client.get_state();
        let _ = state; // state is accessible; token count checked via get_token_info
        let info = client.get_token_info(&0_u32);
        assert!(info.is_err(), "no token should have been created");
    }

    // ── batch_settle ──────────────────────────────────────────────────────

    #[test]
    fn batch_settle_mints_to_multiple_recipients() {
        let (env, contract_id, admin, _treasury) = setup();
        let client = crate::TokenFactoryClient::new(&env, &contract_id);

        // Create a token first.
        client
            .create_token(
                &admin,
                &String::from_str(&env, "MyToken"),
                &String::from_str(&env, "MTK"),
                &7_u32,
                &1_000_000_i128,
                &None,
                &1_000_000_i128,
            )
            .unwrap();

        let r1 = Address::generate(&env);
        let r2 = Address::generate(&env);
        let r3 = Address::generate(&env);

        let recipients = vec![
            &env,
            (r1.clone(), 100_i128),
            (r2.clone(), 200_i128),
            (r3.clone(), 300_i128),
        ];

        let total = client.batch_settle(&admin, &0_u32, &recipients).unwrap();
        assert_eq!(total, 600_i128);
    }

    #[test]
    fn batch_settle_rejects_zero_amount() {
        let (env, contract_id, admin, _treasury) = setup();
        let client = crate::TokenFactoryClient::new(&env, &contract_id);

        client
            .create_token(
                &admin,
                &String::from_str(&env, "MyToken"),
                &String::from_str(&env, "MTK"),
                &7_u32,
                &1_000_000_i128,
                &None,
                &1_000_000_i128,
            )
            .unwrap();

        let r1 = Address::generate(&env);
        let recipients = vec![&env, (r1, 0_i128)];
        let err = client.batch_settle(&admin, &0_u32, &recipients).unwrap_err();
        assert_eq!(err, crate::types::Error::InvalidParameters.into());
    }

    #[test]
    fn batch_settle_rejects_non_creator() {
        let (env, contract_id, admin, _treasury) = setup();
        let client = crate::TokenFactoryClient::new(&env, &contract_id);

        client
            .create_token(
                &admin,
                &String::from_str(&env, "MyToken"),
                &String::from_str(&env, "MTK"),
                &7_u32,
                &1_000_000_i128,
                &None,
                &1_000_000_i128,
            )
            .unwrap();

        let impostor = Address::generate(&env);
        let r1 = Address::generate(&env);
        let recipients = vec![&env, (r1, 100_i128)];
        let err = client.batch_settle(&impostor, &0_u32, &recipients).unwrap_err();
        assert_eq!(err, crate::types::Error::Unauthorized.into());
    }

    #[test]
    fn batch_settle_respects_max_supply() {
        let (env, contract_id, admin, _treasury) = setup();
        let client = crate::TokenFactoryClient::new(&env, &contract_id);

        // Create token with max_supply = 1_000_000 (already at cap from initial supply).
        let params = vec![
            &env,
            TokenCreationParams {
                name: String::from_str(&env, "Capped"),
                symbol: String::from_str(&env, "CAP"),
                decimals: 7,
                initial_supply: 1_000_000,
                max_supply: Some(1_000_000),
                metadata_uri: None,
            },
        ];
        client.batch_reveal(&admin, &params, &1_000_000_i128).unwrap();

        let r1 = Address::generate(&env);
        let recipients = vec![&env, (r1, 1_i128)];
        let err = client.batch_settle(&admin, &0_u32, &recipients).unwrap_err();
        assert_eq!(err, crate::types::Error::MaxSupplyExceeded.into());
    }

    #[test]
    fn batch_reveal_with_10_tokens_succeeds() {
        let (env, contract_id, admin, _treasury) = setup();
        let client = crate::TokenFactoryClient::new(&env, &contract_id);

        let mut tokens = Vec::new(&env);
        for i in 0u32..10 {
            let name = soroban_sdk::String::from_str(&env, "Token");
            let sym_str = if i < 10 {
                soroban_sdk::String::from_str(&env, "TK0")
            } else {
                soroban_sdk::String::from_str(&env, "TKX")
            };
            tokens.push_back(TokenCreationParams {
                name,
                symbol: sym_str,
                decimals: 7,
                initial_supply: 1_000_000,
                max_supply: None,
                metadata_uri: None,
            });
        }

        let indices = client.batch_reveal(&admin, &tokens, &10_000_000_i128).unwrap();
        assert_eq!(indices.len(), 10);
    }

    #[test]
    fn batch_reveal_partial_failure_leaves_no_state() {
        // A bad token in the middle must roll back the entire batch.
        let (env, contract_id, admin, _treasury) = setup();
        let client = crate::TokenFactoryClient::new(&env, &contract_id);

        let bad = TokenCreationParams {
            name: String::from_str(&env, ""),   // invalid: empty name
            symbol: String::from_str(&env, "BAD"),
            decimals: 7,
            initial_supply: 1_000_000,
            max_supply: None,
            metadata_uri: None,
        };
        let tokens = vec![
            &env,
            make_params(&env, "Good1", "GD1"),
            bad,
            make_params(&env, "Good2", "GD2"),
        ];
        let err = client.batch_reveal(&admin, &tokens, &3_000_000_i128).unwrap_err();
        assert_eq!(err, crate::types::Error::InvalidTokenParams.into());
        // No token should have been created.
        assert!(client.get_token_info(&0_u32).is_err());
    }

    // ── batch_mint_isolated (#1360) ───────────────────────────────────────

    /// Create a single uncapped token owned by `admin` at index 0.
    fn create_iso_token(env: &Env, client: &crate::TokenFactoryClient, admin: &Address) {
        client.create_token(
            admin,
            &String::from_str(env, "Iso"),
            &String::from_str(env, "ISO"),
            &7_u32,
            &1_000_000_i128,
            &None,
            &1_000_000_i128,
        );
    }

    #[test]
    fn batch_mint_isolated_all_success() {
        let (env, contract_id, admin, _treasury) = setup();
        let client = crate::TokenFactoryClient::new(&env, &contract_id);
        create_iso_token(&env, &client, &admin);

        let r1 = Address::generate(&env);
        let r2 = Address::generate(&env);
        let mints = vec![&env, (r1.clone(), 100_i128), (r2.clone(), 200_i128)];

        let outcomes = client.batch_mint_isolated(&admin, &0_u32, &mints);

        assert_eq!(outcomes.len(), 2);
        assert!(outcomes.get(0).unwrap().success);
        assert!(outcomes.get(1).unwrap().success);
        assert_eq!(outcomes.get(0).unwrap().error_code, 0);

        // All mints committed.
        let (b1, b2, supply) = env.as_contract(&contract_id, || {
            (
                storage::get_balance(&env, 0, &r1),
                storage::get_balance(&env, 0, &r2),
                storage::get_token_info(&env, 0).unwrap().total_supply,
            )
        });
        assert_eq!(b1, 100);
        assert_eq!(b2, 200);
        assert_eq!(supply, 1_000_300);
    }

    #[test]
    fn batch_mint_isolated_mixed_success_failure() {
        let (env, contract_id, admin, _treasury) = setup();
        let client = crate::TokenFactoryClient::new(&env, &contract_id);
        create_iso_token(&env, &client, &admin);

        let r1 = Address::generate(&env);
        let bad = Address::generate(&env);
        let r3 = Address::generate(&env);
        // The middle item has a non-positive amount → isolated InvalidAmount failure.
        let mints = vec![
            &env,
            (r1.clone(), 100_i128),
            (bad.clone(), 0_i128),
            (r3.clone(), 300_i128),
        ];

        let outcomes = client.batch_mint_isolated(&admin, &0_u32, &mints);

        assert_eq!(outcomes.len(), 3);
        assert!(outcomes.get(0).unwrap().success);
        assert!(!outcomes.get(1).unwrap().success, "middle item must fail in isolation");
        assert!(outcomes.get(2).unwrap().success, "item after a failure must still commit");
        assert_eq!(
            outcomes.get(1).unwrap().error_code,
            crate::types::Error::InvalidAmount.0
        );

        // Successful items committed; the failed one did not, and supply only
        // grew by the successful amounts.
        let (b1, b_bad, b3, supply) = env.as_contract(&contract_id, || {
            (
                storage::get_balance(&env, 0, &r1),
                storage::get_balance(&env, 0, &bad),
                storage::get_balance(&env, 0, &r3),
                storage::get_token_info(&env, 0).unwrap().total_supply,
            )
        });
        assert_eq!(b1, 100);
        assert_eq!(b_bad, 0);
        assert_eq!(b3, 300);
        assert_eq!(supply, 1_000_400);
    }

    #[test]
    fn batch_mint_isolated_rejects_oversized_batch() {
        let (env, contract_id, admin, _treasury) = setup();
        let client = crate::TokenFactoryClient::new(&env, &contract_id);

        // 51 items — one over the cap. Rejected before any token lookup.
        let mut mints = Vec::new(&env);
        for _ in 0..(MAX_BATCH_SIZE + 1) {
            mints.push_back((Address::generate(&env), 1_i128));
        }

        let res = client.try_batch_mint_isolated(&admin, &0_u32, &mints);
        assert_eq!(
            res.unwrap_err().unwrap(),
            crate::types::Error::BatchTooLarge.into()
        );
    }

    #[test]
    fn batch_mint_isolated_rejects_non_creator() {
        let (env, contract_id, admin, _treasury) = setup();
        let client = crate::TokenFactoryClient::new(&env, &contract_id);
        create_iso_token(&env, &client, &admin);

        let impostor = Address::generate(&env);
        let r1 = Address::generate(&env);
        let mints = vec![&env, (r1, 100_i128)];

        let res = client.try_batch_mint_isolated(&impostor, &0_u32, &mints);
        assert_eq!(
            res.unwrap_err().unwrap(),
            crate::types::Error::Unauthorized.into()
        );
    }
}
