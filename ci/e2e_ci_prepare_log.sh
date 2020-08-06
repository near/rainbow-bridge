#!/bin/bash
# hard link pm2 logs to current dir, so buildkite can pick up them as artifacts

mkdir -p ~/.rainbow/logs/eth-relay
mkdir -p ~/.rainbow/logs/near-relay
mkdir -p ~/.rainbow/logs/ganache
mkdir -p ~/.rainbow/logs/near-watchdog
touch eth-relay-out.log
touch eth-relay-err.log
touch near-relay-out.log
touch near-relay-err.log
touch ganache-out.log
touch ganache-err.log
touch near-watchdog-out.log
touch near-watchdog-err.log
if [[ ! -f ~/.rainbow/logs/eth-relay/out.log ]]; then
    ln eth-relay-out.log ~/.rainbow/logs/eth-relay/out.log
    ln eth-relay-err.log ~/.rainbow/logs/eth-relay/err.log
    ln near-relay-out.log ~/.rainbow/logs/near-relay/out.log
    ln near-relay-err.log ~/.rainbow/logs/near-relay/err.log
    ln ganache-out.log ~/.rainbow/logs/ganache/out.log
    ln ganache-err.log ~/.rainbow/logs/ganache/err.log
    ln near-watchdog-out.log ~/.rainbow/logs/near-watchdog/out.log
    ln near-watchdog-err.log ~/.rainbow/logs/near-watchdog/err.log
fi