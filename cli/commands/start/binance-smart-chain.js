// Binance Smart chain configurations to connect with testnet
class StartBinanceSmartChainNodeCommand {
  static async execute ({ ethNodeUrl, ethMasterSk, nearClientValidateHeader }) {
    if (nearClientValidateHeader !== 'true' && nearClientValidateHeader !== 'false') {
      nearClientValidateHeader = 'true'
    }

    if (ethNodeUrl === '') {
      throw new Error('--eth-node-url not set')
    }

    if (ethMasterSk === '') {
      throw new Error('--eth-master-sk not set')
    }

    return {
      ethNodeUrl: ethNodeUrl,
      ethMasterSk: ethMasterSk,
      nearClientValidateHeader: nearClientValidateHeader,
      nearClientValidateHeaderMode: 'bsc'
    }
  }
}

exports.StartBinanceSmartChainNodeCommand = StartBinanceSmartChainNodeCommand
