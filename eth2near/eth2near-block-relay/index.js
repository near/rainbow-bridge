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
  borshSchema
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

function ethashproof (command, _callback) {
  return new Promise((resolve) =>
    exec(command, (error, stdout, _stderr) => {
      if (error) {
        console.error(error)
      }
      resolve(stdout)
    })
  )
}

class Eth2NearRelay {
  initialize (ethClientContract, {
    ethNodeUrl,
    totalSubmitBlock,
    gasPerTransaction,
    metricsPort,
    nearClientValidateHeaderMode
  }) {
    this.validateHeaderMode = nearClientValidateHeaderMode
    this.gasPerTransaction = new BN(gasPerTransaction)
    const limitSubmitBlock = new BN(MAX_GAS_PER_BLOCK).div(this.gasPerTransaction).toNumber()
    this.totalSubmitBlock = parseInt(totalSubmitBlock)
    if (Number.isNaN(this.totalSubmitBlock)) {
      throw new Error(`Invalid total-submit-block (${totalSubmitBlock})`)
    }

    if (this.totalSubmitBlock > limitSubmitBlock) {
      throw new Error(`total-submit-block must be ${limitSubmitBlock} or less. Currently it is: ${this.totalSubmitBlock}`)
    }

    this.ethClientContract = ethClientContract
    this.robustWeb3 = new RobustWeb3(ethNodeUrl)
    this.web3 = this.robustWeb3.web3
    this.metricsPort = metricsPort
  }

  async run () {
    const robustWeb3 = this.robustWeb3
    const httpPrometheus = new HttpPrometheus(this.metricsPort, 'near_bridge_eth2near_')

    const clientBlockNumberGauge = httpPrometheus.gauge('client_block_number', 'current client block number')
    const chainBlockNumberGauge = httpPrometheus.gauge('chain_block_number', 'current chain block number')
    const errorsOnSubmitCounter = httpPrometheus.counter('errors_on_submit', 'number of errors while submitting header')

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

      // Backtrack if chain switched the fork.
      while (true) {
        try {
          const chainBlock = await robustWeb3.getBlock(clientBlockNumber)
          const chainBlockHash = chainBlock.hash
          const clientHashes = await this.ethClientContract.known_hashes(
            clientBlockNumber
          )
          if (clientHashes.find((x) => x === chainBlockHash)) {
            break
          } else {
            console.log(
              `Block ${chainBlockHash} height: ${clientBlockNumber} is not known to the client. Backtracking.`
            )
            clientBlockNumber -= 1
            clientBlockNumberGauge.set(clientBlockNumber)
          }
        } catch (e) {
          console.error(e)
          continue
        }
      }

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
            if (this.validateHeaderMode === 'bsc') {
              const block = await this.robustWeb3.getBlock(i)
              blockPromises.push({ header_rlp: block })
            } else {
              blockPromises.push(this.getParseBlock(i))
            }
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
            `Submit txn to add block ${
              clientBlockNumber + 1
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

  async getParseBlock (blockNumber) {
    try {
      const block = await this.robustWeb3.getBlock(blockNumber)
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

  submitBlock (block, blockNumber) {
    let args = {}

    if (this.validateHeaderMode === 'bsc') {
      args = {
        block_header: web3BlockToRlp(block.header_rlp),
        dag_nodes: []
      }
    } else {
      const h512s = block.elements
        .filter((_, index) => index % 2 === 0)
        .map((element, index) => {
          return (
            this.web3.utils.padLeft(element, 64) +
            this.web3.utils.padLeft(block.elements[index * 2 + 1], 64).substr(2)
          )
        })

      args = {
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
