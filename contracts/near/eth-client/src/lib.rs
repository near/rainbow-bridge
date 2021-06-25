use admin_controlled::Mask;
use borsh::{BorshDeserialize, BorshSerialize};
use eth_types::*;
use near_sdk::collections::UnorderedMap;
use near_sdk::{assert_self, AccountId};
use near_sdk::{env, near_bindgen, PanicOnDefault};

#[cfg(not(target_arch = "wasm32"))]
use serde::{Deserialize, Serialize};

near_sdk::setup_alloc!();

#[cfg(not(target_arch = "wasm32"))]
#[cfg(test)]
mod tests;

#[derive(Default, Debug, Clone, BorshDeserialize, BorshSerialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(Serialize, Deserialize))]
pub struct DoubleNodeWithMerkleProof {
    pub dag_nodes: Vec<H512>, // [H512; 2]
    pub proof: Vec<H128>,
}

impl DoubleNodeWithMerkleProof {
    fn truncate_to_h128(arr: H256) -> H128 {
        let mut data = [0u8; 16];
        data.copy_from_slice(&(arr.0).0[16..]);
        H128(data.into())
    }

    fn hash_h128(l: H128, r: H128) -> H128 {
        let mut data = [0u8; 64];
        data[16..32].copy_from_slice(&(l.0).0);
        data[48..64].copy_from_slice(&(r.0).0);
        Self::truncate_to_h128(near_sha256(&data).into())
    }

    pub fn apply_merkle_proof(&self, index: u64) -> H128 {
        let mut data = [0u8; 128];
        data[..64].copy_from_slice(&(self.dag_nodes[0].0).0);
        data[64..].copy_from_slice(&(self.dag_nodes[1].0).0);

        let mut leaf = Self::truncate_to_h128(near_sha256(&data).into());

        for i in 0..self.proof.len() {
            if (index >> i as u64) % 2 == 0 {
                leaf = Self::hash_h128(leaf, self.proof[i]);
            } else {
                leaf = Self::hash_h128(self.proof[i], leaf);
            }
        }
        leaf
    }
}

/// Minimal information about a header.
#[derive(Default, BorshDeserialize, BorshSerialize)]
pub struct HeaderInfo {
    pub total_difficulty: U256,
    pub parent_hash: H256,
    pub number: u64,
}

const PAUSE_ADD_BLOCK_HEADER: Mask = 1;

#[near_bindgen]
#[derive(BorshDeserialize, BorshSerialize, PanicOnDefault)]
pub struct EthClient {
    /// Whether client validates the PoW when accepting the header. Should only be set to `false`
    /// for debugging, testing, diagnostic purposes when used with Ganache or in PoA testnets
    validate_ethash: bool,
    /// The epoch from which the DAG merkle roots start.
    dags_start_epoch: u64,
    /// DAG merkle roots for the next several years.
    dags_merkle_roots: Vec<H128>,
    /// Hash of the header that has the highest cumulative difficulty. The current head of the
    /// canonical chain.
    best_header_hash: H256,
    /// We store the hashes of the blocks for the past `hashes_gc_threshold` headers.
    /// Events that happen past this threshold cannot be verified by the client.
    /// It is desirable that this number is larger than 7 days worth of headers, which is roughly
    /// 40k Ethereum blocks. So this number should be 40k in production.
    hashes_gc_threshold: u64,
    /// We store full information about the headers for the past `finalized_gc_threshold` blocks.
    /// This is required to be able to adjust the canonical chain when the fork switch happens.
    /// The commonly used number is 500 blocks, so this number should be 500 in production.
    finalized_gc_threshold: u64,
    /// Number of confirmations that applications can use to consider the transaction safe.
    /// For most use cases 25 should be enough, for super safe cases it should be 500.
    num_confirmations: u64,
    /// Hashes of the canonical chain mapped to their numbers. Stores up to `hashes_gc_threshold`
    /// entries.
    /// header number -> header hash
    canonical_header_hashes: UnorderedMap<u64, H256>,
    /// All known header hashes. Stores up to `finalized_gc_threshold`.
    /// header number -> hashes of all headers with this number.
    all_header_hashes: UnorderedMap<u64, Vec<H256>>,
    /// Known headers. Stores up to `finalized_gc_threshold`.
    headers: UnorderedMap<H256, BlockHeader>,
    /// Minimal information about the headers, like cumulative difficulty. Stores up to
    /// `finalized_gc_threshold`.
    infos: UnorderedMap<H256, HeaderInfo>,
    /// If set, block header added by trusted signer will skip validation and added by
    /// others will be immediately rejected, used in PoA testnets
    trusted_signer: Option<AccountId>,
    /// Mask determining all paused functions
    paused: Mask,
}

#[near_bindgen]
impl EthClient {
    #[init]
    pub fn init(
        #[serializer(borsh)] validate_ethash: bool,
        #[serializer(borsh)] dags_start_epoch: u64,
        #[serializer(borsh)] dags_merkle_roots: Vec<H128>,
        #[serializer(borsh)] first_header: Vec<u8>,
        #[serializer(borsh)] hashes_gc_threshold: u64,
        #[serializer(borsh)] finalized_gc_threshold: u64,
        #[serializer(borsh)] num_confirmations: u64,
        #[serializer(borsh)] trusted_signer: Option<AccountId>,
    ) -> Self {
        assert!(!Self::initialized(), "Already initialized");
        let header: BlockHeader = rlp::decode(first_header.as_slice()).unwrap();
        let header_hash = header.hash.unwrap().clone();
        let header_number = header.number;
        let mut res = Self {
            validate_ethash,
            dags_start_epoch,
            dags_merkle_roots,
            best_header_hash: header_hash.clone(),
            hashes_gc_threshold,
            finalized_gc_threshold,
            num_confirmations,
            canonical_header_hashes: UnorderedMap::new(b"c".to_vec()),
            all_header_hashes: UnorderedMap::new(b"a".to_vec()),
            headers: UnorderedMap::new(b"h".to_vec()),
            infos: UnorderedMap::new(b"i".to_vec()),
            trusted_signer,
            paused: Mask::default(),
        };
        res.canonical_header_hashes
            .insert(&header_number, &header_hash);
        res.all_header_hashes
            .insert(&header_number, &vec![header_hash.clone()]);
        res.headers.insert(&header_hash, &header);
        res.infos.insert(
            &header_hash,
            &HeaderInfo {
                total_difficulty: Default::default(),
                parent_hash: Default::default(),
                number: header_number,
            },
        );
        res
    }

    #[result_serializer(borsh)]
    pub fn initialized() -> bool {
        env::state_read::<EthClient>().is_some()
    }

    #[result_serializer(borsh)]
    pub fn dag_merkle_root(&self, #[serializer(borsh)] epoch: u64) -> H128 {
        self.dags_merkle_roots[(&epoch - self.dags_start_epoch) as usize]
    }

    #[result_serializer(borsh)]
    pub fn last_block_number(&self) -> u64 {
        self.infos
            .get(&self.best_header_hash)
            .unwrap_or_default()
            .number
    }

    /// Returns the block hash from the canonical chain.
    #[result_serializer(borsh)]
    pub fn block_hash(&self, #[serializer(borsh)] index: u64) -> Option<H256> {
        self.canonical_header_hashes.get(&index)
    }

    /// Returns all hashes known for that height.
    #[result_serializer(borsh)]
    pub fn known_hashes(&self, #[serializer(borsh)] index: u64) -> Vec<H256> {
        self.all_header_hashes.get(&index).unwrap_or_default()
    }

    /// Returns block hash and the number of confirmations.
    #[result_serializer(borsh)]
    pub fn block_hash_safe(&self, #[serializer(borsh)] index: u64) -> Option<H256> {
        let header_hash = self.block_hash(index)?;
        let last_block_number = self.last_block_number();
        if index + self.num_confirmations > last_block_number {
            None
        } else {
            Some(header_hash)
        }
    }

    /// Add the block header to the client.
    /// `block_header` -- RLP-encoded Ethereum header;
    /// `dag_nodes` -- dag nodes with their merkle proofs.
    #[result_serializer(borsh)]
    pub fn add_block_header(
        &mut self,
        #[serializer(borsh)] block_header: Vec<u8>,
        #[serializer(borsh)] dag_nodes: Vec<DoubleNodeWithMerkleProof>,
    ) {
        self.check_not_paused(PAUSE_ADD_BLOCK_HEADER);
        let header: BlockHeader = rlp::decode(block_header.as_slice()).unwrap();

        if let Some(trusted_signer) = &self.trusted_signer {
            assert_eq!(
                &env::signer_account_id(),
                trusted_signer,
                "Eth-client is deployed as trust mode, only trusted_signer can add a new header"
            );
        } else {
            let prev = self
                .headers
                .get(&header.parent_hash)
                .expect("Parent header should be present to add a new header");
            assert!(
                self.verify_header(&header, &prev, &dag_nodes),
                "The new header {} should be valid",
                header.number
            );
        }

        self.record_header(header);
    }

    pub fn update_trusted_signer(&mut self, trusted_signer: Option<AccountId>) {
        assert_self();
        self.trusted_signer = trusted_signer;
    }

    pub fn get_trusted_signer(&self) -> Option<AccountId> {
        self.trusted_signer.clone()
    }
}

impl EthClient {
    /// Record the header. If needed update the canonical chain and perform the GC.
    fn record_header(&mut self, header: BlockHeader) {
        let best_info = self.infos.get(&self.best_header_hash).unwrap();
        let header_hash = header.hash.unwrap();
        let header_number = header.number;
        if header_number + self.finalized_gc_threshold < best_info.number {
            panic!("Header is too old to have a chance to appear on the canonical chain.");
        }

        let parent_info = self
            .infos
            .get(&header.parent_hash)
            .expect("Header has unknown parent. Parent should be submitted first.");

        // Record this header in `all_hashes`.
        let mut all_hashes = self
            .all_header_hashes
            .get(&header_number)
            .unwrap_or_default();
        assert!(
            all_hashes.iter().find(|x| **x == header_hash).is_none(),
            "Header is already known. Number: {}",
            header_number
        );
        all_hashes.push(header_hash);
        self.all_header_hashes.insert(&header_number, &all_hashes);

        // Record full information about this header.
        self.headers.insert(&header_hash, &header);
        let info = HeaderInfo {
            total_difficulty: parent_info.total_difficulty + header.difficulty,
            parent_hash: header.parent_hash.clone(),
            number: header_number,
        };
        self.infos.insert(&header_hash, &info);

        // Check if canonical chain needs to be updated.
        if info.total_difficulty > best_info.total_difficulty
            || (info.total_difficulty == best_info.total_difficulty
                && header.difficulty % 2 == U256::default())
        {
            // If the new header has a lower number than the previous header, we need to clean it
            // going forward.
            if best_info.number > info.number {
                for number in info.number + 1..=best_info.number {
                    self.canonical_header_hashes.remove(&number);
                }
            }
            // Replacing the global best header hash.
            self.best_header_hash = header_hash;
            self.canonical_header_hashes
                .insert(&header_number, &header_hash);

            // Replacing past hashes until we converge into the same parent.
            // Starting from the parent hash.
            let mut number = header.number - 1;
            let mut current_hash = info.parent_hash;
            loop {
                let prev_value = self.canonical_header_hashes.insert(&number, &current_hash);
                // If the current block hash is 0 (unlikely), or the previous hash matches the
                // current hash, then the chains converged and we can stop now.
                if number == 0 || prev_value == Some(current_hash) {
                    break;
                }
                // Check if there is an info to get the parent hash
                if let Some(info) = self.infos.get(&current_hash) {
                    current_hash = info.parent_hash;
                } else {
                    break;
                }
                number -= 1;
            }
            if header_number >= self.hashes_gc_threshold {
                self.gc_canonical_chain(header_number - self.hashes_gc_threshold);
            }
            if header_number >= self.finalized_gc_threshold {
                self.gc_headers(header_number - self.finalized_gc_threshold);
            }
        }
    }

    /// Remove hashes from the canonical chain that are at least as old as the given header number.
    fn gc_canonical_chain(&mut self, mut header_number: u64) {
        loop {
            if self.canonical_header_hashes.get(&header_number).is_some() {
                self.canonical_header_hashes.remove(&header_number);
                if header_number == 0 {
                    break;
                } else {
                    header_number -= 1;
                }
            } else {
                break;
            }
        }
    }

    /// Remove information about the headers that are at least as old as the given header number.
    fn gc_headers(&mut self, mut header_number: u64) {
        loop {
            if let Some(all_headers) = self.all_header_hashes.get(&header_number) {
                for hash in all_headers {
                    self.headers.remove(&hash);
                    self.infos.remove(&hash);
                }
                self.all_header_hashes.remove(&header_number);
                if header_number == 0 {
                    break;
                } else {
                    header_number -= 1;
                }
            } else {
                break;
            }
        }
    }

    /// Verify PoW of the header.
    fn verify_header(
        &self,
        header: &BlockHeader,
        prev: &BlockHeader,
        dag_nodes: &[DoubleNodeWithMerkleProof],
    ) -> bool {
        let (_mix_hash, result) = self.hashimoto_merkle(
            &header.partial_hash.unwrap(),
            &header.nonce,
            header.number,
            dag_nodes,
        );

        //
        // See YellowPaper formula (50) in section 4.3.4
        // 1. Simplified difficulty check to conform adjusting difficulty bomb
        // 2. Added condition: header.parent_hash() == prev.hash()
        //
        U256((result.0).0.into()) < U256(ethash::cross_boundary(header.difficulty.0))
            && (!self.validate_ethash
                || (header.difficulty < prev.difficulty * 101 / 100
                    && header.difficulty > prev.difficulty * 99 / 100))
            && header.gas_used <= header.gas_limit
            && header.gas_limit < prev.gas_limit * 1025 / 1024
            && header.gas_limit > prev.gas_limit * 1023 / 1024
            && header.gas_limit >= U256(5000.into())
            && header.timestamp > prev.timestamp
            && header.number == prev.number + 1
            && header.parent_hash == prev.hash.unwrap()
            && header.extra_data.len() <= 32
    }

    /// Verify merkle paths to the DAG nodes.
    fn hashimoto_merkle(
        &self,
        header_hash: &H256,
        nonce: &H64,
        header_number: u64,
        nodes: &[DoubleNodeWithMerkleProof],
    ) -> (H256, H256) {
        // Boxed index since ethash::hashimoto gets Fn, but not FnMut
        let index = std::cell::RefCell::new(0);

        // Reuse single Merkle root across all the proofs
        let merkle_root = self.dag_merkle_root((header_number as usize / 30000) as u64);

        let pair = ethash::hashimoto_with_hasher(
            header_hash.0,
            nonce.0,
            ethash::get_full_size(header_number / 30000),
            |offset| {
                let idx = *index.borrow_mut();
                *index.borrow_mut() += 1;

                // Each two nodes are packed into single 128 bytes with Merkle proof
                let node = &nodes[idx / 2];
                if idx % 2 == 0 && self.validate_ethash {
                    // Divide by 2 to adjust offset for 64-byte words instead of 128-byte
                    assert_eq!(merkle_root, node.apply_merkle_proof((offset / 2) as u64));
                };

                // Reverse each 32 bytes for ETHASH compatibility
                let mut data = (node.dag_nodes[idx % 2].0).0;
                data[..32].reverse();
                data[32..].reverse();
                data.into()
            },
            near_keccak256,
            near_keccak512,
        );

        (H256(pair.0), H256(pair.1))
    }
}

admin_controlled::impl_admin_controlled!(EthClient, paused);
