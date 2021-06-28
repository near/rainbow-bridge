// Binance Smart chain configurations to connect with testnet
class StartBinanceSmartChainNodeCommand {
  static async execute ({ ethNodeUrl, ethMasterSk, nearClientValidateHeader }) {
    if (nearClientValidateHeader !== 'true' && nearClientValidateHeader !== 'false') {
      nearClientValidateHeader = 'true'
    }

    return {
      ethNodeUrl: ethNodeUrl !== '' ? ethNodeUrl : 'https://data-seed-prebsc-1-s1.binance.org:8545',
      ethMasterSk: ethMasterSk !== '' ? ethMasterSk : '0x2bdd21761a483f71054e14f5b827213567971c676928d9a1808cbfa4b7501200',
      nearClientValidateHeader: nearClientValidateHeader,
      nearClientValidateHeaderMode: 'bsc'
    }
  }
}

exports.StartBinanceSmartChainNodeCommand = StartBinanceSmartChainNodeCommand
