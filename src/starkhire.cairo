//! StarkHire escrow: a client pays a fixed ERC-20 fee to request a space-data
//! report; the authorized agent submits a SHA-256 report hash; the client
//! confirms and the fee is released to the agent. If the client cancels while
//! the request is still open, or claims a refund after the timeout, the fee
//! returns to the client.
//!
//! The product behaviour is inspired by the author's OrbitHire (NEAR) prototype.
//! This contract is a new Cairo implementation on Starknet, not a deployment
//! of those NEAR contracts.

use starknet::ContractAddress;

pub const STATUS_NONE: u8 = 0;
pub const STATUS_OPEN: u8 = 1;
pub const STATUS_REPORT_SUBMITTED: u8 = 2;
pub const STATUS_RELEASED: u8 = 3;
pub const STATUS_REFUNDED: u8 = 4;
pub const STATUS_CANCELLED: u8 = 5;

#[starknet::interface]
pub trait IStarkHire<TContractState> {
    fn request_service(ref self: TContractState, request_id: ByteArray, query: ByteArray);
    fn submit_report(ref self: TContractState, request_id: ByteArray, report_hash: u256);
    fn confirm_report(ref self: TContractState, request_id: ByteArray);
    fn claim_refund(ref self: TContractState, request_id: ByteArray);
    fn cancel(ref self: TContractState, request_id: ByteArray);
    fn get_fee(self: @TContractState) -> u256;
    fn get_token(self: @TContractState) -> ContractAddress;
    fn get_agent(self: @TContractState) -> ContractAddress;
    fn get_request_status(self: @TContractState, request_id: ByteArray) -> u8;
    fn get_request_commitment(self: @TContractState, request_id: ByteArray) -> u256;
    fn get_report_hash(self: @TContractState, request_id: ByteArray) -> u256;
    fn get_refund_after(self: @TContractState, request_id: ByteArray) -> u64;
    fn get_refund_window_seconds(self: @TContractState) -> u64;
    fn get_rate_limit_seconds(self: @TContractState) -> u64;
}

#[starknet::contract]
pub mod StarkHire {
    use core::num::traits::Zero;
    use core::sha256::compute_sha256_byte_array;
    use openzeppelin_interfaces::erc20::{IERC20Dispatcher, IERC20DispatcherTrait};
    use starknet::storage::{
        Map, StorageMapReadAccess, StorageMapWriteAccess, StoragePointerReadAccess,
        StoragePointerWriteAccess,
    };
    use starknet::{ContractAddress, get_block_timestamp, get_caller_address, get_contract_address};
    use super::{
        STATUS_CANCELLED, STATUS_NONE, STATUS_OPEN, STATUS_REFUNDED, STATUS_RELEASED,
        STATUS_REPORT_SUBMITTED,
    };

    const MAX_QUERY_BYTES: u32 = 2000;
    const MAX_QUERY_CHARS: u32 = 500;

    #[storage]
    struct Storage {
        owner: ContractAddress,
        agent: ContractAddress,
        token: ContractAddress,
        fee: u256,
        refund_window_seconds: u64,
        rate_limit_seconds: u64,
        requests: Map<felt252, Request>,
        last_request_at: Map<ContractAddress, u64>,
    }

    #[derive(Drop, Copy, Serde, starknet::Store)]
    struct Request {
        requester: ContractAddress,
        amount: u256,
        created_at: u64,
        refund_after: u64,
        query_commitment: u256,
        report_hash: u256,
        status: u8,
        exists: bool,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    pub enum Event {
        RequestCreated: RequestCreated,
        ReportSubmitted: ReportSubmitted,
        ReportConfirmed: ReportConfirmed,
        Refunded: Refunded,
        Cancelled: Cancelled,
    }

    #[derive(Drop, starknet::Event)]
    pub struct RequestCreated {
        pub request_key: felt252,
        pub requester: ContractAddress,
        pub query_commitment: u256,
        pub refund_after: u64,
    }

    #[derive(Drop, starknet::Event)]
    pub struct ReportSubmitted {
        pub request_key: felt252,
        pub report_hash: u256,
    }

    #[derive(Drop, starknet::Event)]
    pub struct ReportConfirmed {
        pub request_key: felt252,
        pub agent: ContractAddress,
        pub amount: u256,
    }

    #[derive(Drop, starknet::Event)]
    pub struct Refunded {
        pub request_key: felt252,
        pub requester: ContractAddress,
        pub amount: u256,
    }

    #[derive(Drop, starknet::Event)]
    pub struct Cancelled {
        pub request_key: felt252,
        pub requester: ContractAddress,
        pub amount: u256,
    }

    #[constructor]
    fn constructor(
        ref self: ContractState,
        owner: ContractAddress,
        agent: ContractAddress,
        token: ContractAddress,
        fee: u256,
        refund_window_seconds: u64,
        rate_limit_seconds: u64,
    ) {
        assert(!owner.is_zero(), 'owner is zero');
        assert(!agent.is_zero(), 'agent is zero');
        assert(!token.is_zero(), 'token is zero');
        assert(owner != agent, 'owner equals agent');
        assert(fee > 0, 'fee is zero');
        assert(refund_window_seconds > 0, 'refund window is zero');
        assert(rate_limit_seconds > 0, 'rate limit is zero');
        self.owner.write(owner);
        self.agent.write(agent);
        self.token.write(token);
        self.fee.write(fee);
        self.refund_window_seconds.write(refund_window_seconds);
        self.rate_limit_seconds.write(rate_limit_seconds);
    }

    #[abi(embed_v0)]
    impl StarkHireImpl of super::IStarkHire<ContractState> {
        fn request_service(ref self: ContractState, request_id: ByteArray, query: ByteArray) {
            assert(is_valid_uuid_v4(@request_id), 'invalid request_id');
            assert(is_valid_query(@query), 'invalid query');
            let key = request_key(@request_id);
            let existing = self.requests.read(key);
            assert(!existing.exists, 'duplicate request_id');

            let caller = get_caller_address();
            let now = get_block_timestamp();
            let last = self.last_request_at.read(caller);
            if last != 0 {
                assert(now >= last, 'clock moved backwards');
                assert(now - last >= self.rate_limit_seconds.read(), 'rate limit exceeded');
            }

            let fee = self.fee.read();
            let token = IERC20Dispatcher { contract_address: self.token.read() };
            let ok = token.transfer_from(caller, get_contract_address(), fee);
            assert(ok, 'fee transfer failed');

            let refund_after = now + self.refund_window_seconds.read();
            let commitment = sha256_u256(@query);
            self
                .requests
                .write(
                    key,
                    Request {
                        requester: caller,
                        amount: fee,
                        created_at: now,
                        refund_after,
                        query_commitment: commitment,
                        report_hash: 0,
                        status: STATUS_OPEN,
                        exists: true,
                    },
                );
            self.last_request_at.write(caller, now);
            self
                .emit(
                    Event::RequestCreated(
                        RequestCreated {
                            request_key: key,
                            requester: caller,
                            query_commitment: commitment,
                            refund_after,
                        },
                    ),
                );
        }

        fn submit_report(ref self: ContractState, request_id: ByteArray, report_hash: u256) {
            assert(is_valid_uuid_v4(@request_id), 'invalid request_id');
            assert(report_hash != 0, 'invalid report hash');
            assert(get_caller_address() == self.agent.read(), 'only agent can submit');
            let key = request_key(@request_id);
            let mut request = self.requests.read(key);
            assert(request.exists, 'request not found');
            assert(request.status == STATUS_OPEN, 'request is not open');
            assert(get_block_timestamp() < request.refund_after, 'refund window expired');
            request.report_hash = report_hash;
            request.status = STATUS_REPORT_SUBMITTED;
            self.requests.write(key, request);
            self
                .emit(
                    Event::ReportSubmitted(
                        ReportSubmitted { request_key: key, report_hash },
                    ),
                );
        }

        fn confirm_report(ref self: ContractState, request_id: ByteArray) {
            assert(is_valid_uuid_v4(@request_id), 'invalid request_id');
            let key = request_key(@request_id);
            let mut request = self.requests.read(key);
            assert(request.exists, 'request not found');
            assert(get_caller_address() == request.requester, 'only requester');
            assert(request.status == STATUS_REPORT_SUBMITTED, 'report not submitted');
            let amount = request.amount;
            let agent = self.agent.read();
            request.status = STATUS_RELEASED;
            self.requests.write(key, request);
            let token = IERC20Dispatcher { contract_address: self.token.read() };
            let ok = token.transfer(agent, amount);
            assert(ok, 'agent payout failed');
            self
                .emit(
                    Event::ReportConfirmed(
                        ReportConfirmed { request_key: key, agent, amount },
                    ),
                );
        }

        fn claim_refund(ref self: ContractState, request_id: ByteArray) {
            assert(is_valid_uuid_v4(@request_id), 'invalid request_id');
            let key = request_key(@request_id);
            let mut request = self.requests.read(key);
            assert(request.exists, 'request not found');
            assert(get_caller_address() == request.requester, 'only requester');
            assert(
                request.status == STATUS_OPEN || request.status == STATUS_REPORT_SUBMITTED,
                'not refundable',
            );
            assert(get_block_timestamp() >= request.refund_after, 'refund window not expired');
            let amount = request.amount;
            let requester = request.requester;
            request.status = STATUS_REFUNDED;
            self.requests.write(key, request);
            let token = IERC20Dispatcher { contract_address: self.token.read() };
            let ok = token.transfer(requester, amount);
            assert(ok, 'refund transfer failed');
            self
                .emit(Event::Refunded(Refunded { request_key: key, requester, amount }));
        }

        fn cancel(ref self: ContractState, request_id: ByteArray) {
            assert(is_valid_uuid_v4(@request_id), 'invalid request_id');
            let key = request_key(@request_id);
            let mut request = self.requests.read(key);
            assert(request.exists, 'request not found');
            assert(get_caller_address() == request.requester, 'only requester');
            assert(request.status == STATUS_OPEN, 'request is not open');
            let amount = request.amount;
            let requester = request.requester;
            request.status = STATUS_CANCELLED;
            self.requests.write(key, request);
            let token = IERC20Dispatcher { contract_address: self.token.read() };
            let ok = token.transfer(requester, amount);
            assert(ok, 'cancel transfer failed');
            self
                .emit(Event::Cancelled(Cancelled { request_key: key, requester, amount }));
        }

        fn get_fee(self: @ContractState) -> u256 {
            self.fee.read()
        }

        fn get_token(self: @ContractState) -> ContractAddress {
            self.token.read()
        }

        fn get_agent(self: @ContractState) -> ContractAddress {
            self.agent.read()
        }

        fn get_request_status(self: @ContractState, request_id: ByteArray) -> u8 {
            let request = self.requests.read(request_key(@request_id));
            if request.exists {
                request.status
            } else {
                STATUS_NONE
            }
        }

        fn get_request_commitment(self: @ContractState, request_id: ByteArray) -> u256 {
            self.requests.read(request_key(@request_id)).query_commitment
        }

        fn get_report_hash(self: @ContractState, request_id: ByteArray) -> u256 {
            self.requests.read(request_key(@request_id)).report_hash
        }

        fn get_refund_after(self: @ContractState, request_id: ByteArray) -> u64 {
            self.requests.read(request_key(@request_id)).refund_after
        }

        fn get_refund_window_seconds(self: @ContractState) -> u64 {
            self.refund_window_seconds.read()
        }

        fn get_rate_limit_seconds(self: @ContractState) -> u64 {
            self.rate_limit_seconds.read()
        }
    }

    pub fn request_key(request_id: @ByteArray) -> felt252 {
        let hash = sha256_u256(request_id);
        // Fit the SHA-256 digest into a felt252 key (251 bits).
        let mask: u256 = 0x03ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff;
        (hash & mask).try_into().unwrap()
    }

    pub fn sha256_u256(data: @ByteArray) -> u256 {
        let words = compute_sha256_byte_array(data);
        let span = words.span();
        let mut result: u256 = 0;
        let mut i: usize = 0;
        while i < 8 {
            result = result * 0x100000000 + (*span.at(i)).into();
            i += 1;
        }
        result
    }

    pub fn is_valid_uuid_v4(value: @ByteArray) -> bool {
        if value.len() != 36 {
            return false;
        }
        let mut i: u32 = 0;
        let mut ok = true;
        while i < 36 {
            let byte = value.at(i).unwrap();
            let is_separator = i == 8 || i == 13 || i == 18 || i == 23;
            if is_separator {
                if byte != '-' {
                    ok = false;
                    break;
                }
            } else if !is_ascii_lowercase_hex(byte) {
                ok = false;
                break;
            }
            i += 1;
        }
        if !ok {
            return false;
        }
        let version = value.at(14).unwrap();
        let variant = value.at(19).unwrap();
        version == '4'
            && (variant == '8' || variant == '9' || variant == 'a' || variant == 'b')
    }

    fn is_ascii_lowercase_hex(byte: u8) -> bool {
        (byte >= '0' && byte <= '9') || (byte >= 'a' && byte <= 'f')
    }

    pub fn is_valid_query(value: @ByteArray) -> bool {
        let byte_len = value.len();
        if byte_len == 0 || byte_len > MAX_QUERY_BYTES {
            return false;
        }
        let mut i: u32 = 0;
        let mut chars: u32 = 0;
        let mut only_whitespace = true;
        while i < byte_len {
            let byte = value.at(i).unwrap();
            if byte < 0x20 || byte == 0x7f {
                return false;
            }
            // Count Unicode scalar values encoded as UTF-8 (leading bytes only).
            if byte < 0x80 || byte >= 0xc0 {
                chars += 1;
            }
            if byte != ' ' && byte != '\t' {
                only_whitespace = false;
            }
            i += 1;
        }
        chars > 0 && chars <= MAX_QUERY_CHARS && !only_whitespace
    }
}
