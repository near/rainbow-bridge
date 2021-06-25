#!/bin/bash
set -xeo pipefail

./cli/index.js clean

if test -z $LOCAL_CORE_SRC
then
  ./cli/index.js prepare
else
  ./cli/index.js prepare --core-src $LOCAL_CORE_SRC
fi

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
./cli/index.js start eth2near-relay --metrics-port 8080
./cli/index.js start near2eth-relay --eth-master-sk 0x2bdd21761a483f71054e14f5b827213567971c676928d9a1808cbfa4b7501201 --metrics-port 8181
./cli/index.js start bridge-watchdog --eth-master-sk 0x2bdd21761a483f71054e14f5b827213567971c676928d9a1808cbfa4b7501202
