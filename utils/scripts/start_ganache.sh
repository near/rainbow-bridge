#!/bin/bash
set -euo pipefail

SCRIPTS_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" 2>&1 && pwd )"
cd ${SCRIPTS_DIR}/../../testing/vendor/ganache
ganache_block_time=${GANACHE_BLOCK_TIME:-12}
node_modules/.bin/ganache-cli --port 9545 --blockTime $ganache_block_time --gasLimit 10000000 --account="0x2bdd21761a483f71054e14f5b827213567971c676928d9a1808cbfa4b7501200,10000000000000000000000000000" --account="0x2bdd21761a483f71054e14f5b827213567971c676928d9a1808cbfa4b7501201,10000000000000000000000000000"  --account="0x2bdd21761a483f71054e14f5b827213567971c676928d9a1808cbfa4b7501202,10000000000000000000000000000" --db localnet -h 0.0.0.0
