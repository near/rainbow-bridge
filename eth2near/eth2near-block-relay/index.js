const path = require('path')
const exec = require('child_process').exec
const nearAPI = require('near-api-js')
const BN = require('bn.js')
const { serialize } = require('../../utils/borsh')
const {
  RobustWeb3,
  sleep
} = require('rainbow-bridge-utils')
const {
  web3BlockToRlp,
  EthOnNearClientContract,
  borshSchema,
  getEthBlock
} = require('./eth-on-near-client')
const {
  EthOnNearProverContract
} = require('./eth-on-near-prover')
const {
  EthProofExtractor,
  logFromWeb3,
  receiptFromWeb3,
  ethToNearFindProof
} = require('./eth-proof-extractor')

const {
  HttpPrometheus
} = require('../../utils/http-prometheus.js')

const BRIDGE_SRC_DIR = path.join(__dirname, '..', '..')
const MAX_GAS_PER_BLOCK = '300000000000000'

function ethashproof(command, _callback) {
  return new Promise((resolve) =>
    exec(command, (error, stdout, _stderr) => {
      if (error) {
        console.error(error)
      }
      resolve(stdout)
    })
  )
}

// This function find the result in O(log delta) where delta is the difference between estimatedPosition and the result.
// In particular if estimatedPosition is the correct value it will make two calls to predicate, so it will behave in O(1) in this case.
async function binarySearchWithEstimate(limitLo, limitHi, estimatedPosition, predicate) {
  let lo = limitLo;
  let hi = limitHi;
  let value = await predicate(estimatedPosition);

  if (value) {
    hi = estimatedPosition;
    let step = 1;
    while (hi - step > lo && await predicate(hi - step)) {
      step *= 2;
    }
    hi -= Math.floor(step / 2);
    lo = Math.max(lo, hi - step);
  } else {
    lo = estimatedPosition;
    let step = 1;
    while (lo + step < hi && !await predicate(lo + step)) {
      step *= 2;
    }
    lo += Math.floor(step / 2);
    hi = Math.min(hi, lo + step);
  }

  while (lo + 1 < hi) {
    let mid = Math.floor((lo + hi) / 2);
    if (await predicate(mid)) {
      hi = mid;
    } else {
      lo = mid;
    }
  }
  return hi;
}

class Eth2NearRelay {
  initialize(ethClientContract, {
    ethNodeUrl,
    totalSubmitBlock,
    gasPerTransaction,
    nearNetworkId,
    metricsPort
  }) {
    this.gasPerTransaction = new BN(gasPerTransaction)
    const limitSubmitBlock = new BN(MAX_GAS_PER_BLOCK).div(this.gasPerTransaction).toNumber()
    this.totalSubmitBlock = parseInt(totalSubmitBlock)
    if (Number.isNaN(this.totalSubmitBlock)) {
      throw new Error(`Invalid total-submit-block (${totalSubmitBlock})`)
    }

    if (this.totalSubmitBlock > limitSubmitBlock) {
      throw new Error(`total-submit-block must be ${limitSubmitBlock} or less. Currently it is: ${this.totalSubmitBlock}`)
    }

    this.bridgeId = nearNetworkId
    this.ethClientContract = ethClientContract
    this.robustWeb3 = new RobustWeb3(ethNodeUrl)
    this.web3 = this.robustWeb3.web3
    this.metricsPort = metricsPort
  }

  async run() {
    const robustWeb3 = this.robustWeb3
    const httpPrometheus = new HttpPrometheus(this.metricsPort, 'near_bridge_eth2near_')

    const clientBlockNumberGauge = httpPrometheus.gauge('client_block_number', 'current client block number')
    const chainBlockNumberGauge = httpPrometheus.gauge('chain_block_number', 'current chain block number')
    const errorsOnSubmitCounter = httpPrometheus.counter('errors_on_submit', 'number of errors while submitting header')

    let previousBlockNumber = undefined;

    while (true) {
      let clientBlockNumber
      let chainBlockNumber
      try {
        // Even retry 10 times ethClientContract.last_block_number could still fail
        // Return back to loop to avoid crash eth2near-relay.
        clientBlockNumber = (
          await this.ethClientContract.last_block_number()
        ).toNumber()
        clientBlockNumberGauge.set(clientBlockNumber)
        chainBlockNumber = await robustWeb3.getBlockNumber()
        chainBlockNumberGauge.set(chainBlockNumber)
      } catch (e) {
        console.error(e)
        continue
      }

      let predicate = async (value) => {
        let blockNumber = clientBlockNumber - value;
        console.log('Checking block:', blockNumber);
        try {
          const chainBlock = await getEthBlock(blockNumber, robustWeb3)

          /// Block is not ready
          if (chainBlock === null) {
            const seconds = 3;
            console.log(`Block ${blockNumber} is not ready. Sleeping ${seconds} seconds.`);
            await sleep(seconds * 1000);
            return await predicate(value);
          }

          const chainBlockHash = chainBlock.hash
          const clientHashes = await this.ethClientContract.known_hashes(
            blockNumber
          )
          if (clientHashes.find((x) => x === chainBlockHash)) {
            return true;
          } else {
            return false;
          }
        } catch (e) {
          console.error(e)
          return await predicate(value);
        }
      };

      let estimatedValued = (previousBlockNumber === undefined) ? 0 : clientBlockNumber - (previousBlockNumber + this.totalSubmitBlock);

      /// In case there exist a fork, find how many steps should go backward (delta) to the first block
      /// in the client that is also in the main chain. If the answer is 0, then the current head is valid
      let delta = await binarySearchWithEstimate(0, clientBlockNumber, estimatedValued, predicate);
      clientBlockNumber -= delta;
      previousBlockNumber = clientBlockNumber;

      if (clientBlockNumber < chainBlockNumber) {
        try {
          // Submit add_block txns
          const blockPromises = []
          let endBlock = Math.min(
            clientBlockNumber + this.totalSubmitBlock,
            chainBlockNumber
          )
          if (clientBlockNumber < 5) {
            // Initially, do not add block concurrently
            endBlock = clientBlockNumber + 1
          }
          for (let i = clientBlockNumber + 1; i <= endBlock; i++) {
            blockPromises.push(this.getParseBlock(i))
          }
          const blocks = await Promise.all(blockPromises)
          console.log(
            `Got and parsed block ${clientBlockNumber + 1} to block ${endBlock}`
          )

          // Send all transactions in a single batch, so they are processed in order.
          const actions = []
          for (let i = clientBlockNumber + 1, j = 0; i <= endBlock; i++, j++) {
            const action = this.submitBlock(blocks[j], i)
            actions.push(action)
          }

          const task = this.ethClientContract.account.signAndSendTransaction(this.ethClientContract.contractId, actions)

          console.log(
            `Submit txn to add block ${clientBlockNumber + 1
            } to block ${endBlock}`
          )

          await task

          console.log(
            `Success added block ${clientBlockNumber + 1} to block ${endBlock}. Chain block number: ${chainBlockNumber}`
          )
        } catch (e) {
          errorsOnSubmitCounter.inc(1)
          console.error(e)
        }
      } else {
        await sleep(10000)
      }
    }
  }

  async getParseBlock(blockNumber) {
    try {
      const block = await getEthBlock(blockNumber, this.robustWeb3)
      const blockRlp = this.web3.utils.bytesToHex(
        web3BlockToRlp(block)
      )
      const unparsedBlock = await ethashproof(
        `${BRIDGE_SRC_DIR}/eth2near/ethashproof/cmd/relayer/relayer ${blockRlp} | sed -e '1,/Json output/d'`
      )
      return JSON.parse(unparsedBlock)
    } catch (e) {
      console.error(`Failed to get or parse block ${blockNumber}: ${e}`)
    }
  }

  submitBlock(block, blockNumber) {
    const h512s = block.elements
      .filter((_, index) => index % 2 === 0)
      .map((element, index) => {
        return (
          this.web3.utils.padLeft(element, 64) +
          this.web3.utils.padLeft(block.elements[index * 2 + 1], 64).substr(2)
        )
      })

    let args = {
      block_header: this.web3.utils.hexToBytes(block.header_rlp),
      dag_nodes: h512s
        .filter((_, index) => index % 2 === 0)
        .map((element, index) => {
          return {
            dag_nodes: [element, h512s[index * 2 + 1]],
            proof: block.merkle_proofs
              .slice(
                index * block.proof_length,
                (index + 1) * block.proof_length
              )
              .map((leaf) => this.web3.utils.padLeft(leaf, 32))
          }
        })
    }

    args = serialize(borshSchema, 'addBlockHeaderInput', args)
    return nearAPI.transactions.functionCall('add_block_header', args, this.gasPerTransaction)
  }
}

exports.Eth2NearRelay = Eth2NearRelay
exports.EthProofExtractor = EthProofExtractor
exports.ethashproof = ethashproof
exports.EthOnNearClientContract = EthOnNearClientContract
exports.EthOnNearProverContract = EthOnNearProverContract
exports.logFromWeb3 = logFromWeb3
exports.receiptFromWeb3 = receiptFromWeb3
exports.ethToNearFindProof = ethToNearFindProof
