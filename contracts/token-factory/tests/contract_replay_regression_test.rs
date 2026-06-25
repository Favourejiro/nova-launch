#![cfg(test)]

use soroban_sdk::{testutils::{Address as _, Ledger}, Address, Env};

#[derive(Debug, PartialEq, Clone)]
enum Error {
    Unauthorized, InvalidParameters, InvalidAmount, TokenNotFound,
    ContractPaused, AlreadyExecuted, ProposalCancelled, ProposalNotQueued,
    NoPendingAdmin, WrongPendingAdmin, AlreadyVoted,
}

#[derive(Debug, PartialEq, Clone)]
enum ProposalState { Queued, Executed, Cancelled }

#[derive(Clone)]
struct StreamInfo {
    creator: Address, recipient: Address,
    amount: i128, claimed_amount: i128,
    start_time: u64, end_time: u64,
    cancelled: bool, paused: bool,
}

#[derive(Clone)]
struct Proposal {
    state: ProposalState, eta: u64,
    cancelled_at: Option<u64>, executed_at: Option<u64>,
}

use std::cell::RefCell;
use std::collections::HashMap;

thread_local! {
    static STREAMS: RefCell<HashMap<u64, StreamInfo>> = RefCell::new(HashMap::new());
    static PROPOSALS: RefCell<HashMap<u64, Proposal>> = RefCell::new(HashMap::new());
    static ADMIN: RefCell<Option<Address>> = RefCell::new(None);
    static PENDING_ADMIN: RefCell<Option<Address>> = RefCell::new(None);
}

fn reset_state() {
    STREAMS.with(|s| s.borrow_mut().clear());
    PROPOSALS.with(|p| p.borrow_mut().clear());
    ADMIN.with(|a| *a.borrow_mut() = None);
    PENDING_ADMIN.with(|p| *p.borrow_mut() = None);
}
fn set_stream(id: u64, s: StreamInfo) { STREAMS.with(|m| { m.borrow_mut().insert(id, s); }); }
fn get_stream(id: u64) -> Option<StreamInfo> { STREAMS.with(|m| m.borrow().get(&id).cloned()) }
fn set_proposal(id: u64, p: Proposal) { PROPOSALS.with(|m| { m.borrow_mut().insert(id, p); }); }
fn get_proposal(id: u64) -> Option<Proposal> { PROPOSALS.with(|m| m.borrow().get(&id).cloned()) }
fn set_admin(a: Address) { ADMIN.with(|v| *v.borrow_mut() = Some(a)); }
fn get_admin() -> Option<Address> { ADMIN.with(|v| v.borrow().clone()) }
fn set_pending_admin(a: Option<Address>) { PENDING_ADMIN.with(|v| *v.borrow_mut() = a); }
fn get_pending_admin() -> Option<Address> { PENDING_ADMIN.with(|v| v.borrow().clone()) }

fn propose_admin(caller: &Address, new_admin: &Address) -> Result<(), Error> {
    if get_admin().as_ref() != Some(caller) { return Err(Error::Unauthorized); }
    set_pending_admin(Some(new_admin.clone()));
    Ok(())
}

fn accept_admin(caller: &Address) -> Result<(), Error> {
    match get_pending_admin() {
        None => Err(Error::NoPendingAdmin),
        Some(p) if p != *caller => Err(Error::WrongPendingAdmin),
        Some(p) => { set_admin(p); set_pending_admin(None); Ok(()) }
    }
}

fn execute_proposal(env: &Env, pid: u64) -> Result<(), Error> {
    let mut p = get_proposal(pid).ok_or(Error::ProposalNotQueued)?;
    match p.state {
        ProposalState::Executed  => return Err(Error::AlreadyExecuted),
        ProposalState::Cancelled => return Err(Error::ProposalCancelled),
        ProposalState::Queued    => {}
    }
    if env.ledger().timestamp() <= p.eta { return Err(Error::InvalidParameters); }
    p.state = ProposalState::Executed;
    p.executed_at = Some(env.ledger().timestamp());
    set_proposal(pid, p);
    Ok(())
}

fn cancel_stream(caller: &Address, sid: u64) -> Result<(), Error> {
    let mut s = get_stream(sid).ok_or(Error::TokenNotFound)?;
    if s.creator != *caller { return Err(Error::Unauthorized); }
    if s.cancelled { return Err(Error::InvalidParameters); }
    s.cancelled = true;
    set_stream(sid, s);
    Ok(())
}

fn claim_stream(env: &Env, recipient: &Address, sid: u64) -> Result<i128, Error> {
    let mut s = get_stream(sid).ok_or(Error::TokenNotFound)?;
    if s.recipient != *recipient { return Err(Error::Unauthorized); }
    if s.cancelled { return Err(Error::InvalidParameters); }
    if s.paused    { return Err(Error::ContractPaused); }
    let now = env.ledger().timestamp();
    let vested = if now >= s.end_time { s.amount }
        else if now <= s.start_time { 0 }
        else {
            let e = now - s.start_time;
            let d = s.end_time - s.start_time;
            s.amount * e as i128 / d as i128
        };
    let claimable = vested - s.claimed_amount;
    if claimable <= 0 { return Err(Error::InvalidAmount); }
    s.claimed_amount += claimable;
    set_stream(sid, s);
    Ok(claimable)
}

fn make_env() -> Env { let e = Env::default(); e.mock_all_auths(); e }

fn make_stream_fixture(env: &Env) -> (u64, Address, Address) {
    reset_state();
    let creator   = Address::generate(env);
    let recipient = Address::generate(env);
    set_stream(0, StreamInfo {
        creator: creator.clone(), recipient: recipient.clone(),
        amount: 10_000, claimed_amount: 0,
        start_time: 1_000, end_time: 2_000,
        cancelled: false, paused: false,
    });
    (0, creator, recipient)
}

fn make_proposal_fixture(env: &Env) -> (u64, u64) {
    reset_state();
    let eta = env.ledger().timestamp() + 3_600;
    set_proposal(1, Proposal { state: ProposalState::Queued, eta, cancelled_at: None, executed_at: None });
    (1, eta)
}

fn make_admin_fixture(env: &Env) -> (Address, Address) {
    reset_state();
    let admin     = Address::generate(env);
    let new_admin = Address::generate(env);
    set_admin(admin.clone());
    (admin, new_admin)
}

#[test]
fn test_accept_admin_replay_fails_after_acceptance() {
    let env = make_env();
    let (admin, new_admin) = make_admin_fixture(&env);
    propose_admin(&admin, &new_admin).unwrap();
    accept_admin(&new_admin).unwrap();
    assert_eq!(get_admin(), Some(new_admin.clone()));
    assert_eq!(accept_admin(&new_admin), Err(Error::NoPendingAdmin));
}

#[test]
fn test_accept_admin_replay_is_deterministic() {
    let env = make_env();
    let (admin, new_admin) = make_admin_fixture(&env);
    propose_admin(&admin, &new_admin).unwrap();
    accept_admin(&new_admin).unwrap();
    for i in 0..5 {
        assert_eq!(accept_admin(&new_admin), Err(Error::NoPendingAdmin), "replay #{}", i+1);
    }
    assert_eq!(get_admin(), Some(new_admin));
}

#[test]
fn test_accept_admin_stale_replay_fails() {
    let env = make_env();
    let (admin, first) = make_admin_fixture(&env);
    let second = Address::generate(&env);
    propose_admin(&admin, &first).unwrap();
    propose_admin(&admin, &second).unwrap();
    for i in 0..3 {
        assert_eq!(accept_admin(&first), Err(Error::WrongPendingAdmin), "stale replay #{}", i+1);
    }
    accept_admin(&second).unwrap();
    assert_eq!(get_admin(), Some(second));
}

#[test]
fn test_old_admin_cannot_replay_accept_after_transfer() {
    let env = make_env();
    let (admin, new_admin) = make_admin_fixture(&env);
    propose_admin(&admin, &new_admin).unwrap();
    accept_admin(&new_admin).unwrap();
    assert!(accept_admin(&admin).is_err());
    assert_eq!(get_admin(), Some(new_admin));
}

#[test]
fn test_execute_proposal_replay_fails() {
    let env = make_env();
    let (pid, eta) = make_proposal_fixture(&env);
    env.ledger().with_mut(|li| li.timestamp = eta + 1);
    execute_proposal(&env, pid).unwrap();
    assert_eq!(get_proposal(pid).unwrap().state, ProposalState::Executed);
    assert_eq!(execute_proposal(&env, pid), Err(Error::AlreadyExecuted));
}

#[test]
fn test_execute_proposal_replay_is_deterministic() {
    let env = make_env();
    let (pid, eta) = make_proposal_fixture(&env);
    env.ledger().with_mut(|li| li.timestamp = eta + 1);
    execute_proposal(&env, pid).unwrap();
    for i in 0..5 {
        assert_eq!(execute_proposal(&env, pid), Err(Error::AlreadyExecuted), "replay #{}", i+1);
    }
}

#[test]
fn test_execute_cancelled_proposal_replay_fails() {
    let env = make_env();
    let (pid, eta) = make_proposal_fixture(&env);
    let mut p = get_proposal(pid).unwrap();
    p.state = ProposalState::Cancelled;
    p.cancelled_at = Some(env.ledger().timestamp());
    set_proposal(pid, p);
    env.ledger().with_mut(|li| li.timestamp = eta + 1);
    for i in 0..3 {
        assert_eq!(execute_proposal(&env, pid), Err(Error::ProposalCancelled), "attempt #{}", i+1);
    }
}

#[test]
fn test_two_proposals_no_cross_replay() {
    let env = make_env();
    reset_state();
    let eta1 = env.ledger().timestamp() + 1_000;
    let eta2 = env.ledger().timestamp() + 2_000;
    set_proposal(1, Proposal { state: ProposalState::Queued, eta: eta1, cancelled_at: None, executed_at: None });
    set_proposal(2, Proposal { state: ProposalState::Queued, eta: eta2, cancelled_at: None, executed_at: None });
    env.ledger().with_mut(|li| li.timestamp = eta1 + 1);
    execute_proposal(&env, 1).unwrap();
    assert_eq!(get_proposal(2).unwrap().state, ProposalState::Queued);
    env.ledger().with_mut(|li| li.timestamp = eta2 + 1);
    execute_proposal(&env, 2).unwrap();
    assert_eq!(execute_proposal(&env, 1), Err(Error::AlreadyExecuted));
    assert_eq!(execute_proposal(&env, 2), Err(Error::AlreadyExecuted));
}

#[test]
fn test_claim_stream_replay_same_timestamp_fails() {
    let env = make_env();
    let (sid, _, recipient) = make_stream_fixture(&env);
    env.ledger().with_mut(|li| li.timestamp = 1_500);
    assert!(claim_stream(&env, &recipient, sid).unwrap() > 0);
    assert_eq!(claim_stream(&env, &recipient, sid), Err(Error::InvalidAmount));
}

#[test]
fn test_claim_stream_replay_after_full_vesting_fails() {
    let env = make_env();
    let (sid, _, recipient) = make_stream_fixture(&env);
    env.ledger().with_mut(|li| li.timestamp = 3_000);
    assert_eq!(claim_stream(&env, &recipient, sid).unwrap(), 10_000);
    assert_eq!(claim_stream(&env, &recipient, sid), Err(Error::InvalidAmount));
}

#[test]
fn test_claim_stream_replay_is_deterministic() {
    let env = make_env();
    let (sid, _, recipient) = make_stream_fixture(&env);
    env.ledger().with_mut(|li| li.timestamp = 3_000);
    claim_stream(&env, &recipient, sid).unwrap();
    for i in 0..5 {
        assert_eq!(claim_stream(&env, &recipient, sid), Err(Error::InvalidAmount), "replay #{}", i+1);
    }
    let s = get_stream(sid).unwrap();
    assert_eq!(s.claimed_amount, s.amount);
}

#[test]
fn test_claim_stream_replay_on_cancelled_fails() {
    let env = make_env();
    let (sid, creator, recipient) = make_stream_fixture(&env);
    env.ledger().with_mut(|li| li.timestamp = 1_500);
    let partial = claim_stream(&env, &recipient, sid).unwrap();
    cancel_stream(&creator, sid).unwrap();
    for i in 0..3 {
        assert_eq!(claim_stream(&env, &recipient, sid), Err(Error::InvalidParameters), "claim #{}", i+1);
    }
    assert_eq!(get_stream(sid).unwrap().claimed_amount, partial);
}

#[test]
fn test_claim_stream_unauthorized_replay_fails() {
    let env = make_env();
    let (sid, _, recipient) = make_stream_fixture(&env);
    let attacker = Address::generate(&env);
    env.ledger().with_mut(|li| li.timestamp = 1_500);
    claim_stream(&env, &recipient, sid).unwrap();
    for i in 0..3 {
        assert_eq!(claim_stream(&env, &attacker, sid), Err(Error::Unauthorized), "attacker replay #{}", i+1);
    }
}

#[test]
fn test_claim_stream_incremental_no_double_accounting() {
    let env = make_env();
    let (sid, _, recipient) = make_stream_fixture(&env);
    env.ledger().with_mut(|li| li.timestamp = 1_250);
    let c1 = claim_stream(&env, &recipient, sid).unwrap();
    assert_eq!(c1, 2_500);
    env.ledger().with_mut(|li| li.timestamp = 1_500);
    let c2 = claim_stream(&env, &recipient, sid).unwrap();
    assert_eq!(c2, 2_500);
    env.ledger().with_mut(|li| li.timestamp = 3_000);
    let c3 = claim_stream(&env, &recipient, sid).unwrap();
    assert_eq!(c3, 5_000);
    let s = get_stream(sid).unwrap();
    assert_eq!(c1 + c2 + c3, s.amount);
    assert_eq!(s.claimed_amount, s.amount);
    assert_eq!(claim_stream(&env, &recipient, sid), Err(Error::InvalidAmount));
}

#[test]
fn test_cancel_stream_replay_fails() {
    let env = make_env();
    let (sid, creator, _) = make_stream_fixture(&env);
    cancel_stream(&creator, sid).unwrap();
    assert_eq!(cancel_stream(&creator, sid), Err(Error::InvalidParameters));
}

#[test]
fn test_cancel_stream_replay_is_deterministic() {
    let env = make_env();
    let (sid, creator, _) = make_stream_fixture(&env);
    cancel_stream(&creator, sid).unwrap();
    for i in 0..5 {
        assert_eq!(cancel_stream(&creator, sid), Err(Error::InvalidParameters), "replay #{}", i+1);
    }
    assert!(get_stream(sid).unwrap().cancelled);
}

#[test]
fn test_cancel_stream_unauthorized_replay_fails() {
    let env = make_env();
    let (sid, creator, _) = make_stream_fixture(&env);
    let attacker = Address::generate(&env);
    for i in 0..3 {
        assert_eq!(cancel_stream(&attacker, sid), Err(Error::Unauthorized), "attacker replay #{}", i+1);
    }
    assert!(!get_stream(sid).unwrap().cancelled);
    cancel_stream(&creator, sid).unwrap();
    assert!(get_stream(sid).unwrap().cancelled);
}

#[test]
fn test_cancel_then_claim_replay_no_state_drift() {
    let env = make_env();
    let (sid, creator, recipient) = make_stream_fixture(&env);
    env.ledger().with_mut(|li| li.timestamp = 1_500);
    let pre = claim_stream(&env, &recipient, sid).unwrap();
    assert!(pre > 0);
    cancel_stream(&creator, sid).unwrap();
    let claimed_at_cancel = get_stream(sid).unwrap().claimed_amount;
    assert_eq!(cancel_stream(&creator, sid), Err(Error::InvalidParameters));
    for _ in 0..3 { let _ = claim_stream(&env, &recipient, sid); }
    assert_eq!(get_stream(sid).unwrap().claimed_amount, claimed_at_cancel);
}


// ─────────────────────────────────────────────────────────────────────────────
// Vault Deposit Replay Tests
// ─────────────────────────────────────────────────────────────────────────────
//
// Design: vault deposit (fund_vault) is IDEMPOTENT-ADDITIVE, not replay-protected.
// Multiple deposits from the same funder with the same amount are valid and each
// increases the vault balance independently. Replay protection applies at a higher
// level (sequence numbers / nonces in the Stellar transaction layer). Within the
// contract, a deposit after a vault is cancelled or fully-claimed MUST be rejected
// via `Error::InvalidParameters`, protecting against stale-state replays.

#[derive(Clone, PartialEq, Debug)]
enum VaultStatus { Active, Claimed, Cancelled }

#[derive(Clone)]
struct VaultRecord {
    owner: Address,
    funder: Address,
    total_deposited: i128,
    unlock_time: u64,
    status: VaultStatus,
}

thread_local! {
    static VAULTS: std::cell::RefCell<std::collections::HashMap<u64, VaultRecord>> =
        std::cell::RefCell::new(std::collections::HashMap::new());
}

fn reset_vaults() { VAULTS.with(|v| v.borrow_mut().clear()); }
fn set_vault(id: u64, v: VaultRecord) { VAULTS.with(|m| { m.borrow_mut().insert(id, v); }); }
fn get_vault(id: u64) -> Option<VaultRecord> { VAULTS.with(|m| m.borrow().get(&id).cloned()) }

fn deposit_vault(vault_id: u64, funder: &Address, amount: i128) -> Result<i128, Error> {
    if amount <= 0 { return Err(Error::InvalidParameters); }
    let mut v = get_vault(vault_id).ok_or(Error::TokenNotFound)?;
    match v.status {
        VaultStatus::Active => {}
        _ => return Err(Error::InvalidParameters),
    }
    v.total_deposited = v.total_deposited.checked_add(amount).ok_or(Error::InvalidParameters)?;
    let new_total = v.total_deposited;
    set_vault(vault_id, v);
    let _ = funder; // auth checked by runtime in production
    Ok(new_total)
}

fn cancel_vault(vault_id: u64, caller: &Address) -> Result<(), Error> {
    let mut v = get_vault(vault_id).ok_or(Error::TokenNotFound)?;
    if v.owner != *caller { return Err(Error::Unauthorized); }
    if v.status != VaultStatus::Active { return Err(Error::InvalidParameters); }
    v.status = VaultStatus::Cancelled;
    set_vault(vault_id, v);
    Ok(())
}

fn make_vault_fixture(env: &Env) -> (u64, Address, Address) {
    reset_vaults();
    reset_state();
    let owner  = Address::generate(env);
    let funder = Address::generate(env);
    set_vault(42, VaultRecord {
        owner: owner.clone(), funder: funder.clone(),
        total_deposited: 0, unlock_time: 9_999_999_999, status: VaultStatus::Active,
    });
    (42, owner, funder)
}

/// vault deposit is idempotent-additive: repeated identical deposits each succeed
/// and each independently increment the balance (no single-use nonce at this layer).
#[test]
fn test_vault_deposit_replay_protection_idempotent_additive() {
    let env = make_env();
    let (vid, _owner, funder) = make_vault_fixture(&env);

    let after_first  = deposit_vault(vid, &funder, 1_000).unwrap();
    let after_second = deposit_vault(vid, &funder, 1_000).unwrap();

    // Both succeed; each increments the total
    assert_eq!(after_first,  1_000);
    assert_eq!(after_second, 2_000);
    assert_eq!(get_vault(vid).unwrap().total_deposited, 2_000);
}

/// a deposit replayed against a CANCELLED vault must be rejected with InvalidParameters
/// (stale-state replay protection).
#[test]
fn test_vault_deposit_replay_on_cancelled_fails() {
    let env = make_env();
    let (vid, owner, funder) = make_vault_fixture(&env);

    deposit_vault(vid, &funder, 500).unwrap();
    cancel_vault(vid, &owner).unwrap();

    // Replaying the identical deposit now hits the cancelled guard
    let result = deposit_vault(vid, &funder, 500);
    assert_eq!(result, Err(Error::InvalidParameters));
}

/// repeated cancellation attempts are idempotent-failing after the first success.
#[test]
fn test_vault_cancel_replay_fails() {
    let env = make_env();
    let (vid, owner, _funder) = make_vault_fixture(&env);

    cancel_vault(vid, &owner).unwrap();
    for i in 0..3 {
        assert_eq!(cancel_vault(vid, &owner), Err(Error::InvalidParameters),
                   "cancel replay #{}", i + 1);
    }
    assert_eq!(get_vault(vid).unwrap().status, VaultStatus::Cancelled);
}

/// zero-amount deposit is always rejected — prevents trivially replayed no-ops
/// that could pollute event logs or inflate sequence state.
#[test]
fn test_vault_deposit_zero_amount_rejected() {
    let env = make_env();
    let (vid, _owner, funder) = make_vault_fixture(&env);

    for _ in 0..3 {
        assert_eq!(deposit_vault(vid, &funder, 0), Err(Error::InvalidParameters));
    }
    assert_eq!(get_vault(vid).unwrap().total_deposited, 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Governance Vote Replay Tests
// ─────────────────────────────────────────────────────────────────────────────
//
// Design: governance voting is REPLAY-PROTECTED. Each address may cast exactly
// one vote per proposal. A second identical call MUST return `Error::AlreadyVoted`
// (code 47) and MUST NOT alter the vote tallies recorded by the first call.

#[derive(Clone, PartialEq, Debug)]
enum VoteChoice { For, Against, Abstain }

#[derive(Clone, PartialEq, Debug)]
enum GovProposalState { Active, Ended }

#[derive(Clone)]
struct GovProposal {
    state: GovProposalState,
    start_time: u64,
    end_time: u64,
    for_votes: u64,
    against_votes: u64,
    abstain_votes: u64,
}

thread_local! {
    static GOV_PROPOSALS: std::cell::RefCell<std::collections::HashMap<u64, GovProposal>> =
        std::cell::RefCell::new(std::collections::HashMap::new());
    static GOV_VOTES: std::cell::RefCell<std::collections::HashMap<(u64, String), VoteChoice>> =
        std::cell::RefCell::new(std::collections::HashMap::new());
}

fn reset_gov() {
    GOV_PROPOSALS.with(|p| p.borrow_mut().clear());
    GOV_VOTES.with(|v| v.borrow_mut().clear());
}
fn set_gov_proposal(id: u64, p: GovProposal) { GOV_PROPOSALS.with(|m| { m.borrow_mut().insert(id, p); }); }
fn get_gov_proposal(id: u64) -> Option<GovProposal> { GOV_PROPOSALS.with(|m| m.borrow().get(&id).cloned()) }
fn has_voted_gov(pid: u64, voter: &Address) -> bool {
    let key = (pid, format!("{:?}", voter));
    GOV_VOTES.with(|m| m.borrow().contains_key(&key))
}
fn record_vote(pid: u64, voter: &Address, choice: VoteChoice) {
    let key = (pid, format!("{:?}", voter));
    GOV_VOTES.with(|m| { m.borrow_mut().insert(key, choice); });
}

fn gov_vote(env: &Env, voter: &Address, pid: u64, choice: VoteChoice) -> Result<(), Error> {
    let mut p = get_gov_proposal(pid).ok_or(Error::InvalidParameters)?;
    let now = env.ledger().timestamp();
    if now < p.start_time { return Err(Error::InvalidParameters); }
    if now >= p.end_time  { return Err(Error::InvalidParameters); }
    if p.state != GovProposalState::Active { return Err(Error::InvalidParameters); }
    if has_voted_gov(pid, voter) { return Err(Error::AlreadyVoted); }
    match choice {
        VoteChoice::For     => p.for_votes     += 1,
        VoteChoice::Against => p.against_votes += 1,
        VoteChoice::Abstain => p.abstain_votes += 1,
    }
    record_vote(pid, voter, choice);
    set_gov_proposal(pid, p);
    Ok(())
}

fn make_gov_fixture(env: &Env) -> u64 {
    reset_gov();
    let now = env.ledger().timestamp();
    set_gov_proposal(99, GovProposal {
        state: GovProposalState::Active,
        start_time: now,
        end_time: now + 86_400,
        for_votes: 0, against_votes: 0, abstain_votes: 0,
    });
    99
}

/// voting twice with the same choice must return AlreadyVoted on the second call.
#[test]
fn test_governance_vote_replay_fails() {
    let env = make_env();
    let pid   = make_gov_fixture(&env);
    let voter = Address::generate(&env);

    gov_vote(&env, &voter, pid, VoteChoice::For).unwrap();
    assert_eq!(gov_vote(&env, &voter, pid, VoteChoice::For), Err(Error::AlreadyVoted));
}

/// vote tallies must not change after a replay attempt — state is frozen for that voter.
#[test]
fn test_governance_vote_replay_does_not_change_tally() {
    let env = make_env();
    let pid   = make_gov_fixture(&env);
    let voter = Address::generate(&env);

    gov_vote(&env, &voter, pid, VoteChoice::For).unwrap();
    let snapshot = get_gov_proposal(pid).unwrap().for_votes;

    for i in 0..5 {
        assert_eq!(gov_vote(&env, &voter, pid, VoteChoice::For), Err(Error::AlreadyVoted),
                   "replay #{}", i + 1);
    }
    assert_eq!(get_gov_proposal(pid).unwrap().for_votes, snapshot,
               "tally must not grow after replays");
}

/// changing the vote choice on replay must also be rejected (not a vote-change mechanism).
#[test]
fn test_governance_vote_replay_different_choice_fails() {
    let env = make_env();
    let pid   = make_gov_fixture(&env);
    let voter = Address::generate(&env);

    gov_vote(&env, &voter, pid, VoteChoice::For).unwrap();
    // Attempting to switch to Against via a replay must still be rejected
    assert_eq!(gov_vote(&env, &voter, pid, VoteChoice::Against), Err(Error::AlreadyVoted));
    // Original for-vote must be intact
    let p = get_gov_proposal(pid).unwrap();
    assert_eq!(p.for_votes, 1);
    assert_eq!(p.against_votes, 0);
}

/// two distinct voters may each vote once; replaying voter-1's tx must not affect voter-2.
#[test]
fn test_governance_vote_replay_no_cross_voter_pollution() {
    let env = make_env();
    let pid    = make_gov_fixture(&env);
    let voter1 = Address::generate(&env);
    let voter2 = Address::generate(&env);

    gov_vote(&env, &voter1, pid, VoteChoice::For).unwrap();
    gov_vote(&env, &voter2, pid, VoteChoice::Against).unwrap();

    // Replaying voter-1
    assert_eq!(gov_vote(&env, &voter1, pid, VoteChoice::For), Err(Error::AlreadyVoted));

    let p = get_gov_proposal(pid).unwrap();
    assert_eq!(p.for_votes,     1);
    assert_eq!(p.against_votes, 1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Stream Claim Replay Tests
// ─────────────────────────────────────────────────────────────────────────────
//
// The stream-claim logic already exists in the simulation above (claim_stream /
// make_stream_fixture). The tests below verify replay protection specifically under
// scenarios not covered by the existing suite: partial-vest replay and mid-stream
// time-advance replay.

/// replaying a claim at the exact same timestamp as a successful prior claim must fail
/// because all vested tokens for that instant were already drawn.
/// Design: REPLAY-PROTECTED via claimed_amount tracking (no double-accounting).
#[test]
fn test_stream_claim_replay_protection_same_amount_rejected() {
    let env = make_env();
    let (sid, _, recipient) = make_stream_fixture(&env);
    env.ledger().with_mut(|li| li.timestamp = 1_200);

    let first = claim_stream(&env, &recipient, sid).unwrap();
    assert!(first > 0, "first claim must yield tokens");

    // Identical replay at same time: vested == already-claimed, so nothing remains
    assert_eq!(claim_stream(&env, &recipient, sid), Err(Error::InvalidAmount));
}

/// replaying after advancing time still respects previously claimed amount;
/// only the newly-vested increment is available.
#[test]
fn test_stream_claim_replay_incremental_no_double_payout() {
    let env = make_env();
    let (sid, _, recipient) = make_stream_fixture(&env);

    env.ledger().with_mut(|li| li.timestamp = 1_100);
    let c1 = claim_stream(&env, &recipient, sid).unwrap(); // 10% vested

    env.ledger().with_mut(|li| li.timestamp = 1_100); // same time
    // Replay: nothing new has vested
    assert_eq!(claim_stream(&env, &recipient, sid), Err(Error::InvalidAmount));

    env.ledger().with_mut(|li| li.timestamp = 1_600); // now 60% vested
    let c2 = claim_stream(&env, &recipient, sid).unwrap();

    // Total claimed must equal exactly vested — no duplication
    let s = get_stream(sid).unwrap();
    assert_eq!(c1 + c2, s.claimed_amount);
    assert!(c2 < s.amount - c1, "c2 must not exceed remaining unvested");
}

// ─────────────────────────────────────────────────────────────────────────────
// Campaign Execute Replay Tests
// ─────────────────────────────────────────────────────────────────────────────
//
// Design: campaign state-changing operations (complete/cancel) are REPLAY-PROTECTED
// via terminal-state guards. Once a campaign reaches Completed or Cancelled status
// any repeated call with identical parameters MUST return the appropriate terminal
// error rather than re-executing. Pause/resume replays are likewise blocked by
// CampaignAlreadyPaused / CampaignNotPaused guards.

#[derive(Clone, Copy, PartialEq, Debug)]
enum CampaignState { Active, Paused, Completed, Cancelled }

#[derive(Clone)]
struct Campaign {
    owner: Address,
    state: CampaignState,
    execution_count: u32,
}

thread_local! {
    static CAMPAIGNS: std::cell::RefCell<std::collections::HashMap<u64, Campaign>> =
        std::cell::RefCell::new(std::collections::HashMap::new());
}

fn reset_campaigns() { CAMPAIGNS.with(|c| c.borrow_mut().clear()); }
fn set_campaign(id: u64, c: Campaign) { CAMPAIGNS.with(|m| { m.borrow_mut().insert(id, c); }); }
fn get_campaign(id: u64) -> Option<Campaign> { CAMPAIGNS.with(|m| m.borrow().get(&id).cloned()) }

fn campaign_execute(id: u64, caller: &Address) -> Result<u32, Error> {
    let mut c = get_campaign(id).ok_or(Error::InvalidParameters)?;
    if c.owner != *caller { return Err(Error::Unauthorized); }
    match c.state {
        CampaignState::Active  => {}
        CampaignState::Paused     => return Err(Error::InvalidParameters),
        CampaignState::Completed  => return Err(Error::AlreadyExecuted),
        CampaignState::Cancelled  => return Err(Error::ProposalCancelled),
    }
    c.execution_count += 1;
    let count = c.execution_count;
    set_campaign(id, c);
    Ok(count)
}

fn campaign_complete(id: u64, caller: &Address) -> Result<(), Error> {
    let mut c = get_campaign(id).ok_or(Error::InvalidParameters)?;
    if c.owner != *caller { return Err(Error::Unauthorized); }
    match c.state {
        CampaignState::Active  => {}
        CampaignState::Paused     => return Err(Error::InvalidParameters),
        CampaignState::Completed  => return Err(Error::AlreadyExecuted),
        CampaignState::Cancelled  => return Err(Error::ProposalCancelled),
    }
    c.state = CampaignState::Completed;
    set_campaign(id, c);
    Ok(())
}

fn campaign_cancel(id: u64, caller: &Address) -> Result<(), Error> {
    let mut c = get_campaign(id).ok_or(Error::InvalidParameters)?;
    if c.owner != *caller { return Err(Error::Unauthorized); }
    match c.state {
        CampaignState::Completed  => return Err(Error::AlreadyExecuted),
        CampaignState::Cancelled  => return Err(Error::ProposalCancelled),
        _ => {}
    }
    c.state = CampaignState::Cancelled;
    set_campaign(id, c);
    Ok(())
}

fn make_campaign_fixture(env: &Env) -> (u64, Address) {
    reset_campaigns();
    let owner = Address::generate(env);
    set_campaign(7, Campaign { owner: owner.clone(), state: CampaignState::Active, execution_count: 0 });
    (7, owner)
}

/// executing a campaign step twice is allowed while Active — each call increments
/// execution_count. Replay protection in production is enforced by the min_interval
/// guard; here we verify the execution_count monotonically increases.
#[test]
fn test_campaign_execute_step_increments_count() {
    let env = make_env();
    let (cid, owner) = make_campaign_fixture(&env);

    let c1 = campaign_execute(cid, &owner).unwrap();
    let c2 = campaign_execute(cid, &owner).unwrap();

    assert_eq!(c1, 1);
    assert_eq!(c2, 2);
    assert_eq!(get_campaign(cid).unwrap().execution_count, 2);
}

/// once a campaign is Completed, any further execute/complete call is
/// replay-protected and MUST return AlreadyExecuted.
#[test]
fn test_campaign_complete_replay_fails() {
    let env = make_env();
    let (cid, owner) = make_campaign_fixture(&env);

    campaign_complete(cid, &owner).unwrap();
    assert_eq!(get_campaign(cid).unwrap().state, CampaignState::Completed);

    // Replay complete
    assert_eq!(campaign_complete(cid, &owner), Err(Error::AlreadyExecuted));
    // Replay execute step
    assert_eq!(campaign_execute(cid, &owner), Err(Error::AlreadyExecuted));
}

/// once a campaign is Cancelled, any further cancel call is
/// replay-protected and MUST return ProposalCancelled (terminal state).
#[test]
fn test_campaign_cancel_replay_fails() {
    let env = make_env();
    let (cid, owner) = make_campaign_fixture(&env);

    campaign_cancel(cid, &owner).unwrap();
    assert_eq!(get_campaign(cid).unwrap().state, CampaignState::Cancelled);

    for i in 0..3 {
        assert_eq!(campaign_cancel(cid, &owner), Err(Error::ProposalCancelled),
                   "cancel replay #{}", i + 1);
    }
}

/// deterministic check: 5 consecutive replays of complete all return AlreadyExecuted.
#[test]
fn test_campaign_complete_replay_is_deterministic() {
    let env = make_env();
    let (cid, owner) = make_campaign_fixture(&env);

    campaign_complete(cid, &owner).unwrap();
    for i in 0..5 {
        assert_eq!(campaign_complete(cid, &owner), Err(Error::AlreadyExecuted),
                   "replay #{}", i + 1);
    }
}

/// executing on a Cancelled campaign is blocked — cross-state replay guard.
#[test]
fn test_campaign_execute_on_cancelled_fails() {
    let env = make_env();
    let (cid, owner) = make_campaign_fixture(&env);

    campaign_cancel(cid, &owner).unwrap();
    assert_eq!(campaign_execute(cid, &owner), Err(Error::ProposalCancelled));
}

/// two distinct campaigns share no replay state — completing one does not affect the other.
#[test]
fn test_campaign_replay_no_cross_campaign_pollution() {
    let env = make_env();
    reset_campaigns();
    let owner1 = Address::generate(&env);
    let owner2 = Address::generate(&env);
    set_campaign(1, Campaign { owner: owner1.clone(), state: CampaignState::Active, execution_count: 0 });
    set_campaign(2, Campaign { owner: owner2.clone(), state: CampaignState::Active, execution_count: 0 });

    campaign_complete(1, &owner1).unwrap();

    // Campaign 2 must still be executable
    assert_eq!(campaign_execute(2, &owner2).unwrap(), 1);
    // Campaign 1 replays must still be blocked
    assert_eq!(campaign_complete(1, &owner1), Err(Error::AlreadyExecuted));
}
