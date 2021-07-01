package main

import (
	"fmt"
	"os"
	"strconv"

	"github.com/tranvictor/ethashproof"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Printf("Epoch number param is missing. Please run ./cache <epoch_number> instead.\n")
		return
	}
	if len(os.Args) > 2 {
		fmt.Printf("Please pass only 1 param as a epoch number. Please run ./cache <epoch_number> instead.\n")
		return
	}
	number, err := strconv.Atoi(os.Args[1])
	if err != nil {
		fmt.Printf("Please pass a number as epoch number. Please run ./cache <integer> instead.\n")
		fmt.Printf("Error: %s\n", err)
		return
	}

	root, err := ethashproof.CalculateDatasetMerkleRoot(uint64(number), true)
	if err != nil {
		fmt.Printf("Calculating dataset merkle root failed: %s\n", err)
		return
	}

	fmt.Printf("Root: %s\n", root.Hex())
}
