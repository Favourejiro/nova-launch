//! Tests for the Pro-tier clawback feature.
//!
//! Covers:
//! - Successful clawback reduces holder balance and total_supply by exactly `amount`
//! - Clawback on a token with `clawback_enabled = false` panics with ClawbackDisabled (11)
//! - Unauthorized caller (non-admin) panics with Unauthorized (2)
//! - Clawback amount exceeding holder balance panics with InsufficientBalance (7)
//! - Clawback from a frozen account still succeeds
//! - Property: total_supply decreases by exactly the clawback amount

use super::*;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, Env, String};

const INITIAL_SUPPLY: i128 = 1_000_000_0000000;

/// Stand up a factory with one token at index 0 and a funded holder balance.
fn setup(
    clawback_enabled: bool,
) -> (Env, TokenFactoryClient<'static>, Address, Address, Address, u32) {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let holder = Address::generate(&env);

    client.initialize(&admin, &treasury, &70_000_000, &30_000_000);

    // Inject token directly into storage (index 0)
    let token_address = Address::generate(&env);
    let token_info = TokenInfo {
        address: token_address.clone(),
        creator: admin.clone(),
        name: String::from_str(&env, "Pro Token"),
        symbol: String::from_str(&env, "PRO"),
        decimals: 7,
        total_supply: INITIAL_SUPPLY,
        initial_supply: INITIAL_SUPPLY,
        max_supply: None,
        metadata_uri: None,
        metadata_version: 0,
        created_at: env.ledger().timestamp(),
        total_burned: 0,
        burn_count: 0,
        is_paused: false,
        clawback_enabled,
        freeze_enabled: false,
    };

    let token_index: u32 = 0;
    env.as_contract(&contract_id, || {
        storage::set_token_info(&env, token_index, &token_info);
        storage::set_balance(&env, token_index, &holder, INITIAL_SUPPLY);
    });

    // Leak env/client lifetime — acceptable in test-only code via Box::leak.
    let env: &'static Env = Box::leak(Box::new(env));
    let client: TokenFactoryClient<'static> =
        TokenFactoryClient::new(env, &contract_id);

    (env.clone(), client, admin, treasury, holder, token_index)
}

// ── Happy path ───────────────────────────────────────────────────────────────

#[test]
fn clawback_success_reduces_balance_and_supply() {
    let (env, client, admin, _treasury, holder, token_index) = setup(true);

    let amount = 500_0000000_i128;
    client.clawback(&admin, &token_index, &holder, &amount).unwrap();

    let info = client.get_token_info(&token_index);
    let remaining = env.as_contract(&client.address, || {
        storage::get_balance(&env, token_index, &holder)
    });

    assert_eq!(info.total_supply, INITIAL_SUPPLY - amount);
    assert_eq!(info.total_burned, amount);
    assert_eq!(info.burn_count, 1);
    assert_eq!(remaining, INITIAL_SUPPLY - amount);
}

// ── Clawback disabled guard ──────────────────────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #11)")]
fn clawback_panics_when_disabled() {
    let (_env, client, admin, _treasury, holder, token_index) = setup(false);
    client.clawback(&admin, &token_index, &holder, &1_000_000).unwrap();
}

// ── Authorization ────────────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #2)")]
fn clawback_panics_for_unauthorized_caller() {
    let (env, client, _admin, _treasury, holder, token_index) = setup(true);
    let impostor = Address::generate(&env);
    client.clawback(&impostor, &token_index, &holder, &1_000_000).unwrap();
}

// ── Insufficient balance ─────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #7)")]
fn clawback_panics_when_amount_exceeds_balance() {
    let (_env, client, admin, _treasury, holder, token_index) = setup(true);
    client.clawback(&admin, &token_index, &holder, &(INITIAL_SUPPLY + 1)).unwrap();
}

// ── Frozen account ───────────────────────────────────────────────────────────

#[test]
fn clawback_succeeds_on_frozen_account() {
    let (env, client, admin, _treasury, holder, token_index) = setup(true);

    // Retrieve token address so we can freeze the holder
    let info = client.get_token_info(&token_index);
    env.as_contract(&client.address, || {
        storage::set_address_frozen(&env, &info.address, &holder, true);
    });

    // Clawback must succeed despite the freeze
    let amount = 1_0000000_i128;
    client.clawback(&admin, &token_index, &holder, &amount).unwrap();

    let updated = client.get_token_info(&token_index);
    assert_eq!(updated.total_supply, INITIAL_SUPPLY - amount);
}

// ── Token not found ───────────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn clawback_panics_for_nonexistent_token() {
    let (env, client, admin, _treasury, holder, _token_index) = setup(true);
    let bad_index: u32 = 999;
    client.clawback(&admin, &bad_index, &holder, &1_000_000).unwrap();
}

// ── Property: supply decreases by exactly amount ─────────────────────────────

#[test]
fn clawback_supply_decreases_by_exact_amount() {
    // Property: for any valid clawback amount in (0, balance], total_supply
    // decreases by exactly that amount — no more, no less. A fresh factory is
    // stood up per case so each iteration starts from a known supply.
    for amount in [1_i128, 1_000_000, 100_0000000, 999_0000000, INITIAL_SUPPLY] {
        let (_env, client, admin, _treasury, holder, token_index) = setup(true);

        let before = client.get_token_info(&token_index).total_supply;
        client.clawback(&admin, &token_index, &holder, &amount).unwrap();
        let after = client.get_token_info(&token_index).total_supply;

        assert_eq!(
            before - after,
            amount,
            "supply must decrease by exactly the clawback amount ({amount})"
        );
    }
}

// ── Event emission ────────────────────────────────────────────────────────────

#[test]
fn clawback_emits_clwbk_v1_event() {
    use soroban_sdk::testutils::Events;
    use soroban_sdk::{symbol_short, IntoVal, Val};

    let (env, client, admin, _treasury, holder, token_index) = setup(true);
    let amount = 1_0000000_i128;
    client.clawback(&admin, &token_index, &holder, &amount).unwrap();

    let target = symbol_short!("clwbk_v1");
    let found = env.events().all().iter().any(|(_, topics, _)| {
        !topics.is_empty()
            && topics
                .get(0)
                .map(|t| {
                    soroban_sdk::Symbol::try_from_val(&env, &t)
                        .map(|s| s == target)
                        .unwrap_or(false)
                })
                .unwrap_or(false)
    });
    assert!(found, "clwbk_v1 event must be emitted on successful clawback");
}
