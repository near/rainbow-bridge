const {
  RobustWeb3,
  nearAPI,
  maybeCreateAccount,
  verifyAccount
} = require('rainbow-bridge-utils')
const {
  EthOnNearClientContract,
  EthOnNearProverContract
} = require('rainbow-bridge-eth2near-block-relay')

class InitNearContracts {
  static async execute ({
    nearMasterAccount,
    nearMasterSk,
    nearClientAccount,
    nearClientSk,
    nearClientContractPath,
    nearClientInitBalance,
    hashesGcThreshold,
    finalizedGcThreshold,
    numConfirmations,
    nearProverAccount,
    nearProverSk,
    nearProverContractPath,
    nearProverInitBalance,
    nearNodeUrl,
    nearNetworkId,
    nearClientValidateHeader,
    nearClientValidateHeaderMode,
    nearClientTrustedSigner,
    ethNodeUrl
  }) {
    if (!nearClientSk) {
      console.log(
        'Key to call Near Client contract is not specified. Reusing master key.'
      )
      nearClientSk = nearMasterSk
    }
    if (!nearProverSk) {
      console.log(
        'Key to call Near Prover contract is not specified. Reusing master key.'
      )
      nearProverSk = nearMasterSk
    }
    const nearClientPk = nearAPI.KeyPair.fromString(nearClientSk).getPublicKey()
    const nearProverPk = nearAPI.KeyPair.fromString(nearProverSk).getPublicKey()

    const keyStore = new nearAPI.keyStores.InMemoryKeyStore()
    await keyStore.setKey(
      nearNetworkId,
      nearMasterAccount,
      nearAPI.KeyPair.fromString(nearMasterSk)
    )
    await keyStore.setKey(
      nearNetworkId,
      nearClientAccount,
      nearAPI.KeyPair.fromString(nearClientSk)
    )
    await keyStore.setKey(
      nearNetworkId,
      nearProverAccount,
      nearAPI.KeyPair.fromString(nearProverSk)
    )
    const near = await nearAPI.connect({
      nodeUrl: nearNodeUrl,
      networkId: nearNetworkId,
      masterAccount: nearMasterAccount,
      deps: {
        keyStore: keyStore
      }
    })

    console.log('Creating accounts and deploying the contracts.')
    await verifyAccount(near, nearMasterAccount)
    await maybeCreateAccount(
      near,
      nearMasterAccount,
      nearClientAccount,
      nearClientPk,
      nearClientInitBalance,
      nearClientContractPath
    )
    await verifyAccount(near, nearClientAccount)
    await maybeCreateAccount(
      near,
      nearMasterAccount,
      nearProverAccount,
      nearProverPk,
      nearProverInitBalance,
      nearProverContractPath
    )
    await verifyAccount(near, nearProverAccount)

    console.log('Initializing client and prover contracts.')
    const clientContract = new EthOnNearClientContract(
      new nearAPI.Account(near.connection, nearClientAccount),
      nearClientAccount
    )
    const robustWeb3 = new RobustWeb3(ethNodeUrl)

    // get chain id used only by the bsc verify header.
    const chainID = await robustWeb3.web3.eth.net.getId()

    // check if the nearClientValidateHeaderMode is either 'ethash' or 'bsc' if not set
    // 'ethash' as default
    if (nearClientValidateHeaderMode !== 'ethash' && nearClientValidateHeaderMode !== 'bsc') {
      nearClientValidateHeaderMode = 'ethash'
    }

    await clientContract.maybeInitialize(
      hashesGcThreshold,
      finalizedGcThreshold,
      numConfirmations,
      nearClientValidateHeader === 'true',
      nearClientValidateHeaderMode,
      nearClientTrustedSigner || null,
      chainID,
      robustWeb3
    )
    const proverContract = new EthOnNearProverContract(
      new nearAPI.Account(near.connection, nearProverAccount),
      nearProverAccount
    )
    await proverContract.maybeInitialize(nearClientAccount)

    robustWeb3.destroy()
    return {
      nearClientSk,
      nearProverSk
    }
  }
}

exports.InitNearContracts = InitNearContracts
