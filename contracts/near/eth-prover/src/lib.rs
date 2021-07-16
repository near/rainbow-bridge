use admin_controlled::Mask;
use borsh::{BorshDeserialize, BorshSerialize};
use eth_types::*;
use near_sdk::{env, ext_contract, near_bindgen, Gas, PanicOnDefault, PromiseOrValue};
use rlp::Rlp;

near_sdk::setup_alloc!();

type AccountId = String;

/// Gas to call block_hash_safe
const BLOCK_HASH_SAFE_GAS: Gas = 10_000_000_000_000;

/// Gas to call on_block_hash
const ON_BLOCK_HASH_GAS: Gas = 5_000_000_000_000;

#[near_bindgen]
#[derive(BorshDeserialize, BorshSerialize, PanicOnDefault)]
pub struct EthProver {
    bridge_smart_contract: AccountId,
    paused: Mask,
}

fn assert_self() {
    assert_eq!(env::current_account_id(), env::predecessor_account_id());
}

/// Defines an interface to call EthProver back as a callback with the result from the
/// EthClient contract.
#[ext_contract(remote_self)]
pub trait RemoteSelf {
    #[result_serializer(borsh)]
    fn on_block_hash(&self, #[serializer(borsh)] expected_block_hash: H256) -> bool;
}

/// Defines an interface to call EthClient contract to get the safe block hash for a given block
/// number. It returns Some(hash) if the block hash is present in the safe canonical chain, or
/// None if the block number is not part of the canonical chain yet.
#[ext_contract(eth_client)]
pub trait RemoteEthClient {
    #[result_serializer(borsh)]
    fn block_hash_safe(&self, #[serializer(borsh)] index: u64) -> Option<H256>;
}

/// Get element at position `pos` from rlp encoded data,
/// and decode it as vector of bytes
fn get_vec(data: &Rlp, pos: usize) -> Vec<u8> {
    data.at(pos).unwrap().as_val::<Vec<u8>>().unwrap()
}

const PAUSE_VERIFY: Mask = 1;

#[near_bindgen]
impl EthProver {
    #[init]
    pub fn init(#[serializer(borsh)] bridge_smart_contract: AccountId) -> Self {
        assert!(
            env::state_read::<EthProver>().is_none(),
            "The contract is already initialized"
        );
        Self {
            bridge_smart_contract,
            paused: Mask::default(),
        }
    }

    /// Implementation of the callback when the EthClient returns data.
    /// This method can only be called by the EthProver contract itself (e.g. as callback).
    /// - `block_hash` is the actual data from the EthClient call
    /// - `expected_block_hash` is the block hash that we expect to be passed by us.
    #[result_serializer(borsh)]
    pub fn on_block_hash(
        &self,
        #[callback]
        #[serializer(borsh)]
        block_hash: Option<H256>,
        #[serializer(borsh)] expected_block_hash: H256,
    ) -> bool {
        assert_self();
        return block_hash == Some(expected_block_hash);
    }

    /// Externally visible method to verify that the given block hash is part of the safe canonical
    /// chain on the remote EthClient contract.
    /// Returns a promise.
    #[result_serializer(borsh)]
    pub fn assert_ethclient_hash(
        &self,
        #[serializer(borsh)] block_number: u64,
        #[serializer(borsh)] expected_block_hash: H256,
    ) -> PromiseOrValue<bool> {
        eth_client::block_hash_safe(
            block_number,
            &self.bridge_smart_contract,
            0,
            BLOCK_HASH_SAFE_GAS,
        )
        .then(remote_self::on_block_hash(
            expected_block_hash,
            &env::current_account_id(),
            0,
            ON_BLOCK_HASH_GAS,
        ))
        .into()
    }

    #[result_serializer(borsh)]
    pub fn verify_log_entry(
        &self,
        #[serializer(borsh)] log_index: u64,
        #[serializer(borsh)] log_entry_data: Vec<u8>,
        #[serializer(borsh)] receipt_index: u64,
        #[serializer(borsh)] receipt_data: Vec<u8>,
        #[serializer(borsh)] header_data: Vec<u8>,
        #[serializer(borsh)] proof: Vec<Vec<u8>>,
        #[serializer(borsh)] skip_bridge_call: bool,
    ) -> PromiseOrValue<bool> {
        self.check_not_paused(PAUSE_VERIFY);
        let log_entry: LogEntry = rlp::decode(log_entry_data.as_slice()).unwrap();
        let receipt: Receipt = rlp::decode(receipt_data.as_slice()).unwrap();
        let header: BlockHeader = rlp::decode(header_data.as_slice()).unwrap();

        // Verify log_entry included in receipt
        assert_eq!(receipt.logs[log_index as usize], log_entry);

        // Verify receipt included into header
        let data =
            Self::verify_trie_proof(header.receipts_root, rlp::encode(&receipt_index), proof);
        let verification_result = receipt_data == data;
        if verification_result && skip_bridge_call {
            return PromiseOrValue::Value(true);
        } else if !verification_result {
            return PromiseOrValue::Value(false);
        }

        // Verify block header was in the bridge
        eth_client::block_hash_safe(
            header.number,
            &self.bridge_smart_contract,
            0,
            BLOCK_HASH_SAFE_GAS,
        )
        .then(remote_self::on_block_hash(
            header.hash.unwrap(),
            &env::current_account_id(),
            0,
            ON_BLOCK_HASH_GAS,
        ))
        .into()
    }

    #[result_serializer(borsh)]
    pub fn verify_state_entry(
        &self,
        #[serializer(borsh)] contract_address: Vec<u8>,
        #[serializer(borsh)] storage_key: Vec<u8>,
        #[serializer(borsh)] state_data: Vec<u8>,
        #[serializer(borsh)] header_data: Vec<u8>,
        #[serializer(borsh)] state_proof: Vec<Vec<u8>>,
        #[serializer(borsh)] storage_proof: Vec<Vec<u8>>,
        #[serializer(borsh)] skip_bridge_call: bool,
    ) -> PromiseOrValue<bool> {
        self.check_not_paused(PAUSE_VERIFY);

        let header: BlockHeader = rlp::decode(header_data.as_slice()).unwrap();

        // Verify receipt included into header
        let account_state_rlp =
            Self::verify_trie_proof(header.state_root, contract_address, state_proof);

        let account_state: AccountState = rlp::decode(account_state_rlp.as_slice()).unwrap();
        let data = Self::verify_trie_proof(account_state.storage_root, storage_key, storage_proof);

        // todo - marcelo was saying we don't need to do this? double check
        let verification_result = state_data == data;

        if verification_result && skip_bridge_call {
            return PromiseOrValue::Value(true);
        } else if !verification_result {
            return PromiseOrValue::Value(false);
        }

        // Verify block header was in the bridge
        eth_client::block_hash_safe(
            header.number,
            &self.bridge_smart_contract,
            0,
            BLOCK_HASH_SAFE_GAS,
        )
            .then(remote_self::on_block_hash(
                header.hash.unwrap(),
                &env::current_account_id(),
                0,
                ON_BLOCK_HASH_GAS,
            ))
            .into()
    }

    #[result_serializer(borsh)]
    pub fn verify_transactions_entry(
        &self,
        #[serializer(borsh)] key: Vec<u8>,
        #[serializer(borsh)] tx_data: Vec<u8>,
        #[serializer(borsh)] header_data: Vec<u8>,
        #[serializer(borsh)] proof: Vec<Vec<u8>>,
        #[serializer(borsh)] skip_bridge_call: bool,
    ) -> PromiseOrValue<bool> {
        self.check_not_paused(PAUSE_VERIFY);

        let header: BlockHeader = rlp::decode(header_data.as_slice()).unwrap();

        // Verify receipt included into header
        let data =
            Self::verify_trie_proof(header.transactions_root, key, proof);
        let verification_result = tx_data == data;
        if verification_result && skip_bridge_call {
            return PromiseOrValue::Value(true);
        } else if !verification_result {
            return PromiseOrValue::Value(false);
        }

        // Verify block header was in the bridge
        eth_client::block_hash_safe(
            header.number,
            &self.bridge_smart_contract,
            0,
            BLOCK_HASH_SAFE_GAS,
        )
            .then(remote_self::on_block_hash(
                header.hash.unwrap(),
                &env::current_account_id(),
                0,
                ON_BLOCK_HASH_GAS,
            ))
            .into()
    }

    /// Verify the proof recursively traversing through the key.
    /// Return the value at the end of the key, in case the proof is valid.
    ///
    /// @param expected_root is the expected root of the current node.
    /// @param key is the key for which we are proving the value.
    /// @param proof contains relevant information to verify data is valid
    ///
    /// Patricia Trie: https://eth.wiki/en/fundamentals/patricia-tree
    /// Patricia Img:  https://ethereum.stackexchange.com/questions/268/ethereum-block-architecture/6413#6413
    ///
    /// Verification:  https://github.com/slockit/in3/wiki/Ethereum-Verification-and-MerkleProof#receipt-proof
    /// Article:       https://medium.com/@ouvrard.pierre.alain/merkle-proof-verification-for-ethereum-patricia-tree-48f29658eec
    /// Python impl:   https://gist.github.com/mfornet/0ff283274c0162f1cca45966bccf69ee
    ///
    fn verify_trie_proof(expected_root: H256, key: Vec<u8>, proof: Vec<Vec<u8>>) -> Vec<u8> {
        let mut actual_key = vec![];
        for el in key {
            actual_key.push(el / 16);
            actual_key.push(el % 16);
        }
        Self::_verify_trie_proof((expected_root.0).0.into(), &actual_key, &proof, 0, 0)
    }

    fn _verify_trie_proof(
        expected_root: Vec<u8>,
        key: &Vec<u8>,
        proof: &Vec<Vec<u8>>,
        key_index: usize,
        proof_index: usize,
    ) -> Vec<u8> {
        let node = &proof[proof_index];

        if key_index == 0 {
            // trie root is always a hash
            assert_eq!(near_keccak256(node), expected_root.as_slice());
        } else if node.len() < 32 {
            // if rlp < 32 bytes, then it is not hashed
            assert_eq!(node.as_slice(), expected_root);
        } else {
            assert_eq!(near_keccak256(node), expected_root.as_slice());
        }

        let node = Rlp::new(&node.as_slice());

        if node.iter().count() == 17 {
            // Branch node
            if key_index == key.len() {
                assert_eq!(proof_index + 1, proof.len());
                get_vec(&node, 16)
            } else {
                let new_expected_root = get_vec(&node, key[key_index] as usize);
                Self::_verify_trie_proof(
                    new_expected_root,
                    key,
                    proof,
                    key_index + 1,
                    proof_index + 1,
                )
            }
        } else {
            // Leaf or extension node
            assert_eq!(node.iter().count(), 2);
            let path_u8 = get_vec(&node, 0);
            // Extract first nibble
            let head = path_u8[0] / 16;
            // assert!(0 <= head); is implicit because of type limits
            assert!(head <= 3);

            // Extract path
            let mut path = vec![];
            if head % 2 == 1 {
                path.push(path_u8[0] % 16);
            }
            for val in path_u8.into_iter().skip(1) {
                path.push(val / 16);
                path.push(val % 16);
            }
            assert_eq!(path.as_slice(), &key[key_index..key_index + path.len()]);

            if head >= 2 {
                // Leaf node
                assert_eq!(proof_index + 1, proof.len());
                assert_eq!(key_index + path.len(), key.len());
                get_vec(&node, 1)
            } else {
                // Extension node
                let new_expected_root = get_vec(&node, 1);
                Self::_verify_trie_proof(
                    new_expected_root,
                    key,
                    proof,
                    key_index + path.len(),
                    proof_index + 1,
                )
            }
        }
    }
}

admin_controlled::impl_admin_controlled!(EthProver, paused);

#[cfg(test)]
mod tests;
