// Binance Smart chain configurations to connect with testnet
class StartBinanceSmartChainNodeCommand {
  static async execute () {
    return {
      ethNodeUrl: 'https://data-seed-prebsc-1-s1.binance.org:8545',
      ethMasterSk: '0x2bdd21761a483f71054e14f5b827213567971c676928d9a1808cbfa4b7501200',
      nearClientValidateHeader: 'true',
      nearClientValidateHeaderMode: 'bsc'
    }
  }
}

exports.StartBinanceSmartChainNodeCommand = StartBinanceSmartChainNodeCommand
