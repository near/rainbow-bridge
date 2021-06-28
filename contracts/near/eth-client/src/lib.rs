use admin_controlled::Mask;
use borsh::{BorshDeserialize, BorshSerialize};
use eth_types::*;
use near_sdk::collections::UnorderedMap;
use near_sdk::AccountId;
use near_sdk::{env, near_bindgen, PanicOnDefault};
use libsecp256k1::{RecoveryId, Signature, Message, recover};
use tiny_keccak::{Hasher, Keccak};

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
    /// Whether client validates the PoW or POSA when accepting the header. Should only be set to `false`
    /// for debugging, testing, diagnostic purposes when used with Ganache or in PoA testnets
    validate_header: bool,
    /// Validate header mode to switch between ethash (POW) and bsc (POSA)
    validate_header_mode: String,
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
    /// Store the bsc epoch header key 
    epoch_header: H256,
    /// chain id
    chain_id: u64,
}

#[near_bindgen]
impl EthClient {
    #[init]
    pub fn init(
        #[serializer(borsh)] validate_header: bool,
        #[serializer(borsh)] validate_header_mode: String,
        #[serializer(borsh)] dags_start_epoch: u64,
        #[serializer(borsh)] dags_merkle_roots: Vec<H128>,
        #[serializer(borsh)] first_header: Vec<u8>,
        #[serializer(borsh)] hashes_gc_threshold: u64,
        #[serializer(borsh)] finalized_gc_threshold: u64,
        #[serializer(borsh)] num_confirmations: u64,
        #[serializer(borsh)] trusted_signer: Option<AccountId>,
        #[serializer(borsh)] chain_id: u64,
    ) -> Self {
        assert!(!Self::initialized(), "Already initialized");
        let header: BlockHeader = rlp::decode(first_header.as_slice()).unwrap();
        let header_hash = header.hash.unwrap().clone();
        let header_number = header.number;
        let mut epoch_header: H256 = H256([0; 32].into());

        // check if the current mode is bsc POSA, then store the epoch header.
        if validate_header_mode == String::from("bsc"){
            if !EthClient::is_epoch(header.number){
                panic!("The initial header for POSA have to be an epoch header");
            }
            epoch_header = header.hash.unwrap();
        }
        
        let mut res = Self {
            validate_header_mode,
            epoch_header: epoch_header,
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
            validate_header,
            chain_id,
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
            assert!(
                &env::signer_account_id() == trusted_signer,
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

        if EthClient::is_epoch(header.number) && self.validate_header_mode == String::from("bsc"){
            self.epoch_header = header.hash.unwrap();            
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

    fn verify_header(
        &self,
        header: &BlockHeader,
        prev: &BlockHeader,
        dag_nodes: &[DoubleNodeWithMerkleProof],
    ) -> bool {
        if self.validate_header_mode == String::from("ethash") {
            // validate ethash POW headers
            return self.verify_header_pow(&header, &prev, &dag_nodes);
        }else if self.validate_header_mode == String::from("bsc") {
            // validate bsc POSA headers 
            return self.verify_header_bsc(&header, &prev);
        }
        false
    }

    fn verify_basic(
        &self,
        header: &BlockHeader,
        prev: &BlockHeader
    ) -> bool{
        header.gas_used <= header.gas_limit
        && header.gas_limit >= U256(5000.into())
        && header.timestamp > prev.timestamp
        && header.number == prev.number + 1
        && header.parent_hash == prev.hash.unwrap()
    }

    // seal and hash bsc header.
    fn seal_hash(&self, header: &BlockHeader, chain_id: U256)-> [u8; 32]{
        let d = SealData{chain_id, header};
        d.seal_hash()
    }

    //  Verify POSA of the binance chain header.
    fn verify_header_bsc(&self, header: &BlockHeader, prev: &BlockHeader) -> bool {
        
        // The genesis block is the always valid dead-end
        if header.number == 0 {
            return true;
        }
        
        // verift basic header properties.
        if !self.verify_basic(header, prev){
            return false;
        }

        let (extra_vanity, extra_seal, validator_bytes_length) = (32, 65, 20);
        let is_epoch = EthClient::is_epoch(header.number);
        let signers_bytes = header.extra_data.len() - (extra_vanity + extra_seal);
        // check it is not an epoch header but contains the signers.
        if !is_epoch && signers_bytes != 0{
            return false;
        }
        
        // check if it is an epoch header and contains the signers.
        if is_epoch && signers_bytes % validator_bytes_length != 0{
            return false;
        }
        
        // Ensure that the mix digest is zero as we don't have fork protection currently
        if header.mix_hash != H256([0; 32].into()) {
            return false;
        }
        
        // uncles_hash should be zero
        if header.uncles_hash == H256([0; 32].into()) {
            return false;
        }
        
        // Verify that the gas limit is <= 2^63-1
        if header.gas_limit > U256((0x7fffffffffffffff as u64).into()) {
            return false;
        }
        
        let prev_gas_limit = format!("{}", prev.gas_limit).parse::<i64>().unwrap();
        let header_gas_limit = format!("{}", header.gas_limit).parse::<i64>().unwrap();
        let diff = (prev_gas_limit-header_gas_limit).abs();
        let limit = prev_gas_limit / 256;
        
        // Verify that the gas limit remains within allowed bounds
        if diff >= limit {
            return false;
        }
        
        if !self.is_author(&header){
            return false
        }
        
        self.is_validator(&header)
    }
    
    // check if the block is an epoch header.
    fn is_epoch(number: u64)->bool{        
        number%200==0
    }
    
    // check if the author is the signer.
    fn is_author(&self, header: &BlockHeader) -> bool{
        
        let extra_seal = 65;
        let seal_hash = self.seal_hash(header, U256(self.chain_id.into()));

        // get the signature from header extra_data
        let signature = header.extra_data[header.extra_data.len()-extra_seal..].to_vec();
        let mut sig = [0u8; 65];
        sig.copy_from_slice(&signature[..]);

        let v = sig[64];
        let mut r = [0u8; 32];
        let mut s = [0u8; 32];
        r.copy_from_slice(&signature[0..32]);
        s.copy_from_slice(&signature[32..64]);
        
        let rec_id = RecoveryId::parse(v).unwrap();
        let mut data = [0u8; 64];
        data[0..32].copy_from_slice(&r[..]);
        data[32..64].copy_from_slice(&s[..]);

        let sig = Signature::parse_standard(&data).unwrap();
        let msg = Message::parse_slice(&seal_hash).unwrap();
        let public_key = recover(&msg, &sig, &rec_id).unwrap();

        let mut keccak = Keccak::v256();
        let mut result = [0u8; 32];
        keccak.update(&public_key.serialize()[1..]);
        keccak.finalize(&mut result);

        let mut address = [0u8; 20];
        address.copy_from_slice(&result[12..]);

        H160(address.into()) == header.author
    }

    fn get_epoch_header(&self) -> BlockHeader{
        self.headers.get(&self.epoch_header).unwrap()
    }

    // check if the auther address is valid and is in the validator set.
    fn is_validator(&self, header: &BlockHeader) -> bool{
        let (extra_vanity, extra_seal, address_size) = (32, 65, 20);

        let epoch_header = if EthClient::is_epoch(header.number) {
            header.clone()
        } else {
            self.get_epoch_header()
        };

        if !self.is_in_validator_set(&epoch_header, header.author) {
            return false;
        }
         
        
        // skip difficulty verification
        if self.validate_header{
            // Ensure that the difficulty corresponds to the turn-ness of the signer
            let validators =
            epoch_header.extra_data[extra_vanity..(epoch_header.extra_data.len() - extra_seal)].to_vec();
            
            // Get validator offset postion.
            let offset = (header.number % ((validators.len() / address_size) as u64)) as usize;
            
            // validate the current author if it's turn with the difficulty.
            let (diff_in_turn, diff_no_turn) = (2, 1);
            let is_turn = Address::from(&validators[(offset * address_size)..((offset + 1) * address_size)]);
            
            if is_turn == header.author && header.difficulty != U256(diff_in_turn.into()){
                return false;
            }
            
            if !(is_turn == header.author) && header.difficulty != U256(diff_no_turn.into()){
                return false;
            }
        }
        true
    }

    /// Verify PoW of the header.
    fn verify_header_pow(
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
            && (!self.validate_header
                || (header.difficulty < prev.difficulty * 101 / 100
                && header.difficulty > prev.difficulty * 99 / 100))
            && header.gas_limit < prev.gas_limit * 1025 / 1024
            && header.gas_limit > prev.gas_limit * 1023 / 1024
            && self.verify_basic(header, prev)
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
                if idx % 2 == 0 && self.validate_header {
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

    // check if the author is in the validators set.
    fn is_in_validator_set (&self, epoch_header: &BlockHeader, add: Address) -> bool{
        
        let (extra_vanity, extra_seal, address_size) = (32, 65, 20);
        let validators =
        epoch_header.extra_data[extra_vanity..(epoch_header.extra_data.len() - extra_seal)].to_vec();
        
        for x in 0..(validators.len() / address_size) {
            let value = &validators[(x * address_size)..((x + 1) * address_size)];
            let _add: Address = Address::from(value);
            if _add == add{
                return true
            }
        }
        false
    }
}

admin_controlled::impl_admin_controlled!(EthClient, paused);
