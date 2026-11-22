use openzeppelin_interfaces::erc20::{IERC20Dispatcher, IERC20DispatcherTrait};
use snforge_std::{
    CheatSpan, ContractClassTrait, DeclareResultTrait, EventSpyAssertionsTrait,
    cheat_caller_address, declare, spy_events, start_cheat_block_timestamp,
};
use starkhire::starkhire::{
    IStarkHireDispatcher, IStarkHireDispatcherTrait, IStarkHireSafeDispatcher,
    IStarkHireSafeDispatcherTrait, StarkHire,
};
use starkhire::starkhire::StarkHire::{is_valid_query, is_valid_uuid_v4, sha256_u256};
use starknet::ContractAddress;

const OWNER: ContractAddress = 0x111.try_into().unwrap();
const AGENT: ContractAddress = 0x222.try_into().unwrap();
const CLIENT: ContractAddress = 0x333.try_into().unwrap();
const OTHER: ContractAddress = 0x444.try_into().unwrap();

const INITIAL_SUPPLY: u256 = 1_000_000;
const FEE: u256 = 100;
const REFUND_WINDOW: u64 = 3_600;
const RATE_LIMIT: u64 = 60;
const START_TIME: u64 = 1_700_000_000;

fn uuid() -> ByteArray {
    "550e8400-e29b-41d4-a716-446655440000"
}

fn uuid2() -> ByteArray {
    "550e8400-e29b-41d4-a716-446655440001"
}

fn query() -> ByteArray {
    "When does the ISS pass over Osorno?"
}

fn report_hash() -> u256 {
    0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
}

fn deploy_token(recipient: ContractAddress) -> ContractAddress {
    let class = declare("MockERC20").unwrap().contract_class();
    let mut calldata = array![];
    INITIAL_SUPPLY.serialize(ref calldata);
    recipient.serialize(ref calldata);
    let (address, _) = class.deploy(@calldata).unwrap();
    address
}

fn deploy_hire(token: ContractAddress) -> ContractAddress {
    let class = declare("StarkHire").unwrap().contract_class();
    let mut calldata = array![];
    OWNER.serialize(ref calldata);
    AGENT.serialize(ref calldata);
    token.serialize(ref calldata);
    FEE.serialize(ref calldata);
    REFUND_WINDOW.serialize(ref calldata);
    RATE_LIMIT.serialize(ref calldata);
    let (address, _) = class.deploy(@calldata).unwrap();
    start_cheat_block_timestamp(address, START_TIME);
    address
}

fn setup() -> (IStarkHireDispatcher, IERC20Dispatcher, ContractAddress) {
    let token_address = deploy_token(CLIENT);
    let hire_address = deploy_hire(token_address);
    let token = IERC20Dispatcher { contract_address: token_address };
    cheat_caller_address(token_address, CLIENT, CheatSpan::TargetCalls(1));
    token.approve(hire_address, INITIAL_SUPPLY);
    (IStarkHireDispatcher { contract_address: hire_address }, token, hire_address)
}

fn request_as_client(hire: IStarkHireDispatcher, hire_address: ContractAddress, id: ByteArray) {
    cheat_caller_address(hire_address, CLIENT, CheatSpan::TargetCalls(1));
    hire.request_service(id, query());
}

#[test]
fn test_validators() {
    assert!(is_valid_uuid_v4(@"550e8400-e29b-41d4-a716-446655440000"));
    assert!(!is_valid_uuid_v4(@"550e8400-e29b-11d4-a716-446655440000"));
    assert!(!is_valid_uuid_v4(@"550E8400-E29B-41D4-A716-446655440000"));
    assert!(!is_valid_uuid_v4(@"550e8400e29b41d4a716446655440000"));
    assert!(is_valid_query(@"When does the ISS pass over Osorno?"));
    assert!(!is_valid_query(@""));
    assert!(!is_valid_query(@"   "));
    assert!(!is_valid_query(@"bad\nquery"));
    let mut too_long: ByteArray = "";
    let mut i: u32 = 0;
    while i < 501 {
        too_long.append_byte('a');
        i += 1;
    }
    assert!(!is_valid_query(@too_long));
    assert!(sha256_u256(@"abc") != 0);
}

#[test]
fn test_request_locks_fee() {
    let (hire, token, hire_address) = setup();
    request_as_client(hire, hire_address, uuid());
    assert!(token.balance_of(CLIENT) == INITIAL_SUPPLY - FEE);
    assert!(token.balance_of(hire_address) == FEE);
    assert!(hire.get_fee() == FEE);
    assert!(hire.get_token() == token.contract_address);
    assert!(hire.get_agent() == AGENT);
    assert!(hire.get_request_status(uuid()) == 1);
    assert!(hire.get_request_commitment(uuid()) == sha256_u256(@query()));
    assert!(hire.get_refund_after(uuid()) == START_TIME + REFUND_WINDOW);
}

#[test]
fn test_request_created_event() {
    let (hire, _, hire_address) = setup();
    let mut spy = spy_events();
    request_as_client(hire, hire_address, uuid());
    let key = StarkHire::request_key(@uuid());
    spy
        .assert_emitted(
            @array![
                (
                    hire_address,
                    StarkHire::Event::RequestCreated(
                        StarkHire::RequestCreated {
                            request_key: key,
                            requester: CLIENT,
                            query_commitment: sha256_u256(@query()),
                            refund_after: START_TIME + REFUND_WINDOW,
                        },
                    ),
                ),
            ],
        );
}

#[test]
#[feature("safe_dispatcher")]
fn test_rejects_invalid_uuid() {
    let (_hire, _, hire_address) = setup();
    let safe = IStarkHireSafeDispatcher { contract_address: hire_address };
    cheat_caller_address(hire_address, CLIENT, CheatSpan::TargetCalls(1));
    match safe.request_service("not-a-uuid", query()) {
        Result::Ok(_) => core::panic_with_felt252('Should have panicked'),
        Result::Err(panic_data) => {
            assert(*panic_data.at(0) == 'invalid request_id', *panic_data.at(0));
        },
    }
}

#[test]
#[feature("safe_dispatcher")]
fn test_rejects_empty_query() {
    let (_hire, _, hire_address) = setup();
    let safe = IStarkHireSafeDispatcher { contract_address: hire_address };
    cheat_caller_address(hire_address, CLIENT, CheatSpan::TargetCalls(1));
    match safe.request_service(uuid(), "") {
        Result::Ok(_) => core::panic_with_felt252('Should have panicked'),
        Result::Err(panic_data) => {
            assert(*panic_data.at(0) == 'invalid query', *panic_data.at(0));
        },
    }
}

#[test]
#[feature("safe_dispatcher")]
fn test_rejects_duplicate_request_id() {
    let (hire, _, hire_address) = setup();
    request_as_client(hire, hire_address, uuid());
    let safe = IStarkHireSafeDispatcher { contract_address: hire_address };
    cheat_caller_address(hire_address, CLIENT, CheatSpan::TargetCalls(1));
    match safe.request_service(uuid(), query()) {
        Result::Ok(_) => core::panic_with_felt252('Should have panicked'),
        Result::Err(panic_data) => {
            assert(*panic_data.at(0) == 'duplicate request_id', *panic_data.at(0));
        },
    }
}

#[test]
#[feature("safe_dispatcher")]
fn test_rate_limit() {
    let (hire, _, hire_address) = setup();
    request_as_client(hire, hire_address, uuid());
    let safe = IStarkHireSafeDispatcher { contract_address: hire_address };
    cheat_caller_address(hire_address, CLIENT, CheatSpan::TargetCalls(1));
    match safe.request_service(uuid2(), query()) {
        Result::Ok(_) => core::panic_with_felt252('Should have panicked'),
        Result::Err(panic_data) => {
            assert(*panic_data.at(0) == 'rate limit exceeded', *panic_data.at(0));
        },
    }
}

#[test]
fn test_second_request_after_rate_limit_window() {
    let (hire, token, hire_address) = setup();
    request_as_client(hire, hire_address, uuid());
    start_cheat_block_timestamp(hire_address, START_TIME + RATE_LIMIT);
    request_as_client(hire, hire_address, uuid2());
    assert!(hire.get_request_status(uuid2()) == 1);
    assert!(token.balance_of(hire_address) == FEE * 2);
}

#[test]
fn test_agent_submits_report() {
    let (hire, _, hire_address) = setup();
    request_as_client(hire, hire_address, uuid());
    cheat_caller_address(hire_address, AGENT, CheatSpan::TargetCalls(1));
    hire.submit_report(uuid(), report_hash());
    assert!(hire.get_request_status(uuid()) == 2);
    assert!(hire.get_report_hash(uuid()) == report_hash());
}

#[test]
#[feature("safe_dispatcher")]
fn test_only_agent_can_submit() {
    let (hire, _, hire_address) = setup();
    request_as_client(hire, hire_address, uuid());
    let safe = IStarkHireSafeDispatcher { contract_address: hire_address };
    cheat_caller_address(hire_address, CLIENT, CheatSpan::TargetCalls(1));
    match safe.submit_report(uuid(), report_hash()) {
        Result::Ok(_) => core::panic_with_felt252('Should have panicked'),
        Result::Err(panic_data) => {
            assert(*panic_data.at(0) == 'only agent can submit', *panic_data.at(0));
        },
    }
}

#[test]
#[feature("safe_dispatcher")]
fn test_cannot_submit_after_timeout() {
    let (hire, _, hire_address) = setup();
    request_as_client(hire, hire_address, uuid());
    start_cheat_block_timestamp(hire_address, START_TIME + REFUND_WINDOW);
    let safe = IStarkHireSafeDispatcher { contract_address: hire_address };
    cheat_caller_address(hire_address, AGENT, CheatSpan::TargetCalls(1));
    match safe.submit_report(uuid(), report_hash()) {
        Result::Ok(_) => core::panic_with_felt252('Should have panicked'),
        Result::Err(panic_data) => {
            assert(*panic_data.at(0) == 'refund window expired', *panic_data.at(0));
        },
    }
}

#[test]
fn test_client_confirm_pays_agent() {
    let (hire, token, hire_address) = setup();
    request_as_client(hire, hire_address, uuid());
    cheat_caller_address(hire_address, AGENT, CheatSpan::TargetCalls(1));
    hire.submit_report(uuid(), report_hash());
    cheat_caller_address(hire_address, CLIENT, CheatSpan::TargetCalls(1));
    hire.confirm_report(uuid());
    assert!(hire.get_request_status(uuid()) == 3);
    assert!(token.balance_of(AGENT) == FEE);
    assert!(token.balance_of(hire_address) == 0);
}

#[test]
fn test_confirm_event() {
    let (hire, _, hire_address) = setup();
    request_as_client(hire, hire_address, uuid());
    cheat_caller_address(hire_address, AGENT, CheatSpan::TargetCalls(1));
    hire.submit_report(uuid(), report_hash());
    let mut spy = spy_events();
    cheat_caller_address(hire_address, CLIENT, CheatSpan::TargetCalls(1));
    hire.confirm_report(uuid());
    let key = StarkHire::request_key(@uuid());
    spy
        .assert_emitted(
            @array![
                (
                    hire_address,
                    StarkHire::Event::ReportConfirmed(
                        StarkHire::ReportConfirmed { request_key: key, agent: AGENT, amount: FEE },
                    ),
                ),
            ],
        );
}

#[test]
#[feature("safe_dispatcher")]
fn test_non_client_cannot_confirm() {
    let (hire, _, hire_address) = setup();
    request_as_client(hire, hire_address, uuid());
    cheat_caller_address(hire_address, AGENT, CheatSpan::TargetCalls(1));
    hire.submit_report(uuid(), report_hash());
    let safe = IStarkHireSafeDispatcher { contract_address: hire_address };
    cheat_caller_address(hire_address, OTHER, CheatSpan::TargetCalls(1));
    match safe.confirm_report(uuid()) {
        Result::Ok(_) => core::panic_with_felt252('Should have panicked'),
        Result::Err(panic_data) => {
            assert(*panic_data.at(0) == 'only requester', *panic_data.at(0));
        },
    }
}

#[test]
#[feature("safe_dispatcher")]
fn test_cannot_confirm_before_submit() {
    let (hire, _, hire_address) = setup();
    request_as_client(hire, hire_address, uuid());
    let safe = IStarkHireSafeDispatcher { contract_address: hire_address };
    cheat_caller_address(hire_address, CLIENT, CheatSpan::TargetCalls(1));
    match safe.confirm_report(uuid()) {
        Result::Ok(_) => core::panic_with_felt252('Should have panicked'),
        Result::Err(panic_data) => {
            assert(*panic_data.at(0) == 'report not submitted', *panic_data.at(0));
        },
    }
}

#[test]
fn test_cancel_refunds_client() {
    let (hire, token, hire_address) = setup();
    request_as_client(hire, hire_address, uuid());
    cheat_caller_address(hire_address, CLIENT, CheatSpan::TargetCalls(1));
    hire.cancel(uuid());
    assert!(hire.get_request_status(uuid()) == 5);
    assert!(token.balance_of(CLIENT) == INITIAL_SUPPLY);
    assert!(token.balance_of(hire_address) == 0);
}

#[test]
#[feature("safe_dispatcher")]
fn test_cannot_cancel_after_submit() {
    let (hire, _, hire_address) = setup();
    request_as_client(hire, hire_address, uuid());
    cheat_caller_address(hire_address, AGENT, CheatSpan::TargetCalls(1));
    hire.submit_report(uuid(), report_hash());
    let safe = IStarkHireSafeDispatcher { contract_address: hire_address };
    cheat_caller_address(hire_address, CLIENT, CheatSpan::TargetCalls(1));
    match safe.cancel(uuid()) {
        Result::Ok(_) => core::panic_with_felt252('Should have panicked'),
        Result::Err(panic_data) => {
            assert(*panic_data.at(0) == 'request is not open', *panic_data.at(0));
        },
    }
}

#[test]
#[feature("safe_dispatcher")]
fn test_non_client_cannot_cancel() {
    let (hire, _, hire_address) = setup();
    request_as_client(hire, hire_address, uuid());
    let safe = IStarkHireSafeDispatcher { contract_address: hire_address };
    cheat_caller_address(hire_address, OTHER, CheatSpan::TargetCalls(1));
    match safe.cancel(uuid()) {
        Result::Ok(_) => core::panic_with_felt252('Should have panicked'),
        Result::Err(panic_data) => {
            assert(*panic_data.at(0) == 'only requester', *panic_data.at(0));
        },
    }
}

#[test]
#[feature("safe_dispatcher")]
fn test_refund_before_timeout_fails() {
    let (hire, _, hire_address) = setup();
    request_as_client(hire, hire_address, uuid());
    let safe = IStarkHireSafeDispatcher { contract_address: hire_address };
    cheat_caller_address(hire_address, CLIENT, CheatSpan::TargetCalls(1));
    match safe.claim_refund(uuid()) {
        Result::Ok(_) => core::panic_with_felt252('Should have panicked'),
        Result::Err(panic_data) => {
            assert(*panic_data.at(0) == 'refund window not expired', *panic_data.at(0));
        },
    }
}

#[test]
fn test_refund_after_timeout_from_open() {
    let (hire, token, hire_address) = setup();
    request_as_client(hire, hire_address, uuid());
    start_cheat_block_timestamp(hire_address, START_TIME + REFUND_WINDOW);
    cheat_caller_address(hire_address, CLIENT, CheatSpan::TargetCalls(1));
    hire.claim_refund(uuid());
    assert!(hire.get_request_status(uuid()) == 4);
    assert!(token.balance_of(CLIENT) == INITIAL_SUPPLY);
}

#[test]
fn test_refund_after_timeout_from_submitted() {
    let (hire, token, hire_address) = setup();
    request_as_client(hire, hire_address, uuid());
    cheat_caller_address(hire_address, AGENT, CheatSpan::TargetCalls(1));
    hire.submit_report(uuid(), report_hash());
    start_cheat_block_timestamp(hire_address, START_TIME + REFUND_WINDOW);
    cheat_caller_address(hire_address, CLIENT, CheatSpan::TargetCalls(1));
    hire.claim_refund(uuid());
    assert!(hire.get_request_status(uuid()) == 4);
    assert!(token.balance_of(CLIENT) == INITIAL_SUPPLY);
    assert!(token.balance_of(AGENT) == 0);
}

#[test]
fn test_status_none_for_unknown_id() {
    let (hire, _, _) = setup();
    assert!(hire.get_request_status(uuid()) == 0);
}

#[test]
#[should_panic]
fn test_constructor_rejects_zero_fee_panics() {
    let token = deploy_token(CLIENT);
    let class = declare("StarkHire").unwrap().contract_class();
    let mut calldata = array![];
    OWNER.serialize(ref calldata);
    AGENT.serialize(ref calldata);
    token.serialize(ref calldata);
    let zero_fee: u256 = 0;
    zero_fee.serialize(ref calldata);
    REFUND_WINDOW.serialize(ref calldata);
    RATE_LIMIT.serialize(ref calldata);
    class.deploy(@calldata).unwrap();
}

#[test]
#[should_panic]
fn test_constructor_rejects_same_owner_and_agent() {
    let token = deploy_token(CLIENT);
    let class = declare("StarkHire").unwrap().contract_class();
    let mut calldata = array![];
    OWNER.serialize(ref calldata);
    OWNER.serialize(ref calldata);
    token.serialize(ref calldata);
    FEE.serialize(ref calldata);
    REFUND_WINDOW.serialize(ref calldata);
    RATE_LIMIT.serialize(ref calldata);
    class.deploy(@calldata).unwrap();
}
