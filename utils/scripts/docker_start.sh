#!/bin/bash
set -xeo pipefail

if [ -f "/root/.nearup/node.pid" ]; then
  rm /root/.nearup/node.pid
fi

if [ -f "/root/.nearup/watcher.pid" ]; then
  rm /root/.nearup/watcher.pid
fi

nearup run localnet --num-nodes 1 --binary-path ~/.rainbow/core/target/debug
./cli/index.js start ganache
sleep 10
./cli/index.js start eth2near-relay --metrics-port 8080
./cli/index.js start near2eth-relay --eth-master-sk 0x2bdd21761a483f71054e14f5b827213567971c676928d9a1808cbfa4b7501201 --metrics-port 8181
./cli/index.js start bridge-watchdog --eth-master-sk 0x2bdd21761a483f71054e14f5b827213567971c676928d9a1808cbfa4b7501202
nohup ./node_modules/.bin/http-server ~/.near/localnet/node0/ -p 9000 -d &
./node_modules/.bin/pm2 logs
