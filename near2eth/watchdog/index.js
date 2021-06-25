const fs = require('fs')
const {
  sleep,
  Web3,
  RobustWeb3,
  normalizeEthKey,
  promiseWithTimeout
} = require('rainbow-bridge-utils')
const Tx = require('ethereumjs-tx').Transaction
const { HttpPrometheus } = require('../../utils/http-prometheus.js')

const SLOW_TX_ERROR_MSG = 'transaction not executed within 5 minutes'

class Watchdog {
  async initialize ({
    ethNodeUrl,
    ethMasterSk,
    ethClientArtifactPath,
    ethClientAddress,
    metricsPort
  }) {
    this.robustWeb3 = new RobustWeb3(ethNodeUrl)
    this.web3 = this.robustWeb3.web3
    this.metricsPort = metricsPort
    const ethMasterAccount = this.web3.eth.accounts.privateKeyToAccount(normalizeEthKey(ethMasterSk))
    this.web3.eth.accounts.wallet.add(ethMasterAccount)
    this.web3.eth.defaultAccount = ethMasterAccount.address
    this.ethMasterAccount = ethMasterAccount.address

    // Initialize client contract.
    console.log('Deploying Near2EthClient contract.')
    this.clientContract = new this.web3.eth.Contract(
      JSON.parse(fs.readFileSync(ethClientArtifactPath)).abi,
      ethClientAddress,
      {
        from: this.ethMasterAccount,
        handleRevert: true
      }
    )
  }

  async run ({
    ethMasterSk,
    ethClientAddress,
    watchdogDelay,
    watchdogErrorDelay
  }) {
    const httpPrometheus = new HttpPrometheus(this.metricsPort, 'near_bridge_watchdog_')
    const lastBlockVerified = httpPrometheus.gauge('last_block_verified', 'last block that was already verified')
    const totBlockProducers = httpPrometheus.gauge('block_producers', 'number of block producers for current block')
    const incorrectBlocks = httpPrometheus.counter('incorrect_blocks', 'number of incorrect blocks found')
    const challengesSubmitted = httpPrometheus.counter('challenges_submitted', 'number of blocks challenged')

    if (ethMasterSk.startsWith('0x')) {
      ethMasterSk = ethMasterSk.slice(2)
    }
    ethMasterSk = Buffer.from(ethMasterSk, 'hex')
    while (true) {
      try {
        const bridgeState = await this.clientContract.methods
          .bridgeState()
          .call()

        const numBlockProducers = Number(bridgeState.numBlockProducers)

        lastBlockVerified.set(Number(bridgeState.currentHeight))
        totBlockProducers.set(numBlockProducers)

        if (Number(bridgeState.nextValidAt) === 0) {
          console.log('No block to check.')
        } else {
          console.log('Checking block.')
          // We cannot memorize processed blocks because they might have been re-submitted with different data.
          for (let i = 0; i < numBlockProducers; i++) {
            console.log(`Checking signature ${i}.`)
            let result
            try {
              result = await this.clientContract.methods
                .checkBlockProducerSignatureInHead(i)
                .call()
            } catch (e) {
              if (e.message.endsWith('No such signature')) {
                console.log('Signature skipped')
                continue
              } else {
                throw e
              }
            }
            if (!result) {
              incorrectBlocks.inc(1)
              console.log(`Challenging signature ${i}.`)
              try {
                let gasPrice = await this.web3.eth.getGasPrice()
                const nonce = await this.web3.eth.getTransactionCount(
                  this.ethMasterAccount
                )
                while (gasPrice < 10000 * 1e9) {
                  try {
                    // Keep sending with same nonce but higher gasPrice to override same txn
                    let tx = new Tx({
                      from: this.ethMasterAccount.address,
                      // this is required otherwise gas is infinite
                      to: ethClientAddress,
                      gasLimit: Web3.utils.toHex(2000000),
                      gasPrice: Web3.utils.toHex(gasPrice),
                      nonce: Web3.utils.toHex(nonce),
                      data: this.clientContract.methods
                        .challenge(this.ethMasterAccount, i)
                        .encodeABI()
                    })
                    tx.sign(ethMasterSk)
                    tx = '0x' + tx.serialize().toString('hex')

                    await promiseWithTimeout(
                      5 * 60 * 1000,
                      this.web3.eth.sendSignedTransaction(tx),
                      SLOW_TX_ERROR_MSG
                    )
                    challengesSubmitted.inc(1)
                    break
                  } catch (e) {
                    if (e.message === SLOW_TX_ERROR_MSG) {
                      console.log(SLOW_TX_ERROR_MSG)
                      console.log(
                        `current gasPrice: ${gasPrice}. rechallenge with double gasPrice`
                      )
                      gasPrice *= 2
                    } else {
                      throw e
                    }
                  }
                }
              } catch (err) {
                console.log(
                  `Challenge failed. Maybe the block was already reverted? ${err}`
                )
              }
              break
            }
          }
        }
        console.log(`Sleeping for ${watchdogDelay} seconds.`)
        await sleep(watchdogDelay * 1000)
      } catch (e) {
        console.log('Error', e)
        await sleep(watchdogErrorDelay * 1000)
      }
    }
  }
}

exports.Watchdog = Watchdog
