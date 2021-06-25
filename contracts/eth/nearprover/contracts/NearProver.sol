// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8;

import "nearbridge/contracts/AdminControlled.sol";
import "nearbridge/contracts/INearBridge.sol";
import "nearbridge/contracts/NearDecoder.sol";
import "./ProofDecoder.sol";
import "./INearProver.sol";

contract NearProver is INearProver, AdminControlled {
    using Borsh for Borsh.Data;
    using NearDecoder for Borsh.Data;
    using ProofDecoder for Borsh.Data;

    INearBridge public bridge;

    constructor(
        INearBridge _bridge,
        address _admin,
        uint _pausedFlags
    ) AdminControlled(_admin, _pausedFlags) {
        bridge = _bridge;
    }

    uint constant UNPAUSE_ALL = 0;
    uint constant PAUSED_VERIFY = 1;

    function proveOutcome(bytes memory proofData, uint64 blockHeight)
        public
        view
        override
        pausable(PAUSED_VERIFY)
        returns (bool)
    {
        Borsh.Data memory borsh = Borsh.from(proofData);
        ProofDecoder.FullOutcomeProof memory fullOutcomeProof = borsh.decodeFullOutcomeProof();
        borsh.done();

        bytes32 hash =
            _computeRoot(fullOutcomeProof.outcome_proof.outcome_with_id.hash, fullOutcomeProof.outcome_proof.proof);

        hash = sha256(abi.encodePacked(hash));

        hash = _computeRoot(hash, fullOutcomeProof.outcome_root_proof);

        require(
            hash == fullOutcomeProof.block_header_lite.inner_lite.outcome_root,
            "NearProver: outcome merkle proof is not valid"
        );

        bytes32 expectedBlockMerkleRoot = bridge.blockMerkleRoots(blockHeight);

        require(
            _computeRoot(fullOutcomeProof.block_header_lite.hash, fullOutcomeProof.block_proof) ==
                expectedBlockMerkleRoot,
            "NearProver: block proof is not valid"
        );

        return true;
    }

    function _computeRoot(bytes32 node, ProofDecoder.MerklePath memory proof) internal pure returns (bytes32 hash) {
        hash = node;
        for (uint i = 0; i < proof.items.length; i++) {
            ProofDecoder.MerklePathItem memory item = proof.items[i];
            if (item.direction == 0) {
                hash = sha256(abi.encodePacked(item.hash, hash));
            } else {
                hash = sha256(abi.encodePacked(hash, item.hash));
            }
        }
    }
}
