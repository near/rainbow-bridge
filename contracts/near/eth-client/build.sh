#!/usr/bin/env bash

# Exit script as soon as a command fails.
set -e

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"

if [[ -z "$BUILDKITE" ]] && [[ "$(uname -s)" != "Darwin" ]];
then
     userflag="-u $UID:$UID"
else
     userflag=""
fi

# simple:latest \
docker run \
     --mount type=bind,source=$DIR/..,target=/host \
     --cap-add=SYS_PTRACE --security-opt seccomp=unconfined $userflag \
     -w /host/eth-client \
     -e RUSTFLAGS='-C link-arg=-s' \
     nearprotocol/contract-builder \
     /bin/bash -c "rustup target add wasm32-unknown-unknown; cargo build --target wasm32-unknown-unknown --release"

cp $DIR/../target/wasm32-unknown-unknown/release/eth_client.wasm $DIR/../res/
