package main

import (
	"encoding/json"
	"fmt"
	"math/big"
	"os"

	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/rlp"
	"github.com/tranvictor/ethashproof"
	"github.com/tranvictor/ethashproof/ethash"
	"github.com/tranvictor/ethashproof/mtree"
)

type Output struct {
	HeaderRLP    string   `json:"header_rlp"`
	MerkleRoot   string   `json:"merkle_root"`
	Elements     []string `json:"elements"`
	MerkleProofs []string `json:"merkle_proofs"`
	ProofLength  uint64   `json:"proof_length"`
}

func main() {
	if len(os.Args) < 2 {
		fmt.Printf("Block rlp param is missing. Please run ./relayer <blockrlp> instead.\n")
		return
	}
	if len(os.Args) > 2 {
		fmt.Printf("Please pass only 1 param as a hex-encoded block rlp. Please run ./relayer <blockrlp> instead.\n")
		return
	}
	rlpheader, err := hexutil.Decode(os.Args[1])
	if err != nil {
		fmt.Printf("Please pass a hex as a block rlp. Please run ./relayer <hex> instead.\n")
		fmt.Printf("Error: %s\n", err)
		return
	}
	fmt.Printf("Decoding block header\n")
	var header *types.Header
	if err := rlp.DecodeBytes(rlpheader, &header); err != nil {
		fmt.Printf("RLP decoding of header failed: %s\n", err)
		return
	}

	blockno := header.Number.Uint64()
	epoch := blockno / 30000
	cache, err := ethashproof.LoadCache(int(epoch))
	if err != nil {
		fmt.Printf("Cache is missing, calculate dataset merkle tree to create the cache first...\n")
		_, err = ethashproof.CalculateDatasetMerkleRoot(epoch, true)
		if err != nil {
			fmt.Printf("Creating cache failed: %s\n", err)
			return
		}
		cache, err = ethashproof.LoadCache(int(epoch))
		if err != nil {
			fmt.Printf("Getting cache failed after trying to creat it: %s. Abort.\n", err)
			return
		}
	}

	fmt.Printf("SealHash: %s\n", ethash.Instance.SealHash(header))

	indices := ethash.Instance.GetVerificationIndices(
		blockno,
		ethash.Instance.SealHash(header),
		header.Nonce.Uint64(),
	)

	fmt.Printf("Proof length: %d\n", cache.ProofLength)

	output := &Output{
		HeaderRLP:    hexutil.Encode(rlpheader),
		MerkleRoot:   cache.RootHash.Hex(),
		Elements:     []string{},
		MerkleProofs: []string{},
		ProofLength:  cache.ProofLength,
	}

	for _, index := range indices {
		element, proof, err := ethashproof.CalculateProof(blockno, index, cache)
		if err != nil {
			fmt.Printf("calculating the proofs failed for index: %d, error: %s\n", index, err)
			return
		}
		es := element.ToUint256Array()
		for _, e := range es {
			output.Elements = append(output.Elements, hexutil.EncodeBig(e))
		}
		allProofs := []*big.Int{}
		for _, be := range mtree.HashesToBranchesArray(proof) {
			allProofs = append(allProofs, be.Big())
		}
		for _, pr := range allProofs {
			output.MerkleProofs = append(output.MerkleProofs, hexutil.EncodeBig(pr))
		}
	}

	fmt.Printf("Json output:\n\n")
	outputJson, _ := json.Marshal(output)
	fmt.Printf("%s\n", outputJson)
}
