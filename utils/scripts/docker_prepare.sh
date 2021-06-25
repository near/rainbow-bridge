#!/bin/bash
set -xeo pipefail

pip3 install nearup
./cli/index.js clean
./cli/index.js prepare
mkdir -p ~/.near/localnet/node0
echo '{"account_id":"node0","public_key":"ed25519:7PGseFbWxvYVgZ89K1uTJKYoKetWs7BJtbyXDzfbAcqX","secret_key":"ed25519:3D4YudUQRE39Lc4JHghuB5WM8kbgDDa34mnrEP5DdTApVH81af7e2dWgNPEaiQfdJnZq1CNPp5im4Rg5b733oiMP"}' > ~/.near/localnet/node0/validator_key.json
echo '{"account_id":"","public_key":"ed25519:7PGseFbWxvYVgZ89K1uTJKYoKetWs7BJtbyXDzfbAcqX","secret_key":"ed25519:3D4YudUQRE39Lc4JHghuB5WM8kbgDDa34mnrEP5DdTApVH81af7e2dWgNPEaiQfdJnZq1CNPp5im4Rg5b733oiMP"}' > ~/.near/localnet/node0/node_key.json

./cli/index.js start near-node
./cli/index.js start ganache
sleep 10
./cli/index.js init-near-contracts
./cli/index.js init-eth-ed25519
./cli/index.js init-eth-client --eth-client-lock-eth-amount 1000000000 --eth-client-lock-duration 10
./cli/index.js init-eth-prover
./cli/index.js init-eth-erc20
./cli/index.js init-eth-locker
./cli/index.js init-near-token-factory

./cli/index.js stop near-node
./cli/index.js stop ganache
