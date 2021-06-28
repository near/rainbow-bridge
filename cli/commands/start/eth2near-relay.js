const ProcessManager = require('pm2')
const { spawnProcess } = require('./helpers')
const {
  EthOnNearClientContract,
  Eth2NearRelay
} = require('rainbow-bridge-eth2near-block-relay')
const { nearAPI } = require('rainbow-bridge-utils')
const path = require('path')

class StartEth2NearRelayCommand {
  static async execute ({
    daemon,
    nearNetworkId,
    nearNodeUrl,
    nearMasterAccount,
    nearMasterSk,
    nearClientAccount,
    totalSubmitBlock,
    gasPerTransaction,
    ethNodeUrl,
    metricsPort,
    nearClientValidateHeaderMode
  }) {
    if (daemon === 'true') {
      ProcessManager.connect((err) => {
        if (err) {
          console.log(
            'Unable to connect to the ProcessManager daemon! Please retry.'
          )
          return
        }
        spawnProcess('eth2near-relay', {
          name: 'eth2near-relay',
          script: path.join(__dirname, '../../index.js'),
          interpreter: 'node',
          error_file: '~/.rainbow/logs/eth2near-relay/err.log',
          out_file: '~/.rainbow/logs/eth2near-relay/out.log',
          args: [
            'start', 'eth2near-relay',
            '--near-network-id', nearNetworkId,
            '--near-node-url', nearNodeUrl,
            '--near-master-account', nearMasterAccount,
            '--near-master-sk', nearMasterSk,
            '--near-client-account', nearClientAccount,
            '--eth-node-url', ethNodeUrl,
            '--total-submit-block', totalSubmitBlock,
            '--gas-per-transaction', gasPerTransaction,
            '--daemon', 'false',
            '--metrics-port', metricsPort
          ],
          wait_ready: true,
          kill_timeout: 60000,
          logDateFormat: 'YYYY-MM-DD HH:mm:ss.SSS'
        })
      })
    } else {
      const keyStore = new nearAPI.keyStores.InMemoryKeyStore()
      await keyStore.setKey(
        nearNetworkId,
        nearMasterAccount,
        nearAPI.KeyPair.fromString(nearMasterSk)
      )
      const near = await nearAPI.connect({
        nodeUrl: nearNodeUrl,
        networkId: nearNetworkId,
        masterAccount: nearMasterAccount,
        deps: {
          keyStore: keyStore
        }
      })

      const relay = new Eth2NearRelay()
      const clientContract = new EthOnNearClientContract(
        new nearAPI.Account(near.connection, nearMasterAccount),
        nearClientAccount
      )
      await clientContract.accessKeyInit()
      console.log('Initializing eth2near-relay...', { ethNodeUrl, metricsPort })
      relay.initialize(clientContract, { ethNodeUrl, totalSubmitBlock, gasPerTransaction, metricsPort, nearClientValidateHeaderMode })
      console.log('Starting eth2near-relay...')
      await relay.run()
    }
  }
}

exports.StartEth2NearRelayCommand = StartEth2NearRelayCommand
