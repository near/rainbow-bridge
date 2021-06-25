const {
  nearAPI,
  remove0x,
  verifyAccount
} = require('rainbow-bridge-utils')
const { BN } = require('ethereumjs-util')

class DeployToken {
  static async execute ({
    tokenName,
    ethTokenAddress,
    nearNodeUrl,
    nearNetworkId,
    nearMasterAccount,
    nearMasterSk,
    nearTokenFactoryAccount,
    nearTokenFactorySk
  }) {
    // use init near instead
    if (!nearTokenFactorySk) {
      console.log(
        'Secret key for fungible token is not specified. Reusing master secret key.'
      )
      nearTokenFactorySk = nearMasterSk
    }

    const keyStore = new nearAPI.keyStores.InMemoryKeyStore()
    await keyStore.setKey(
      nearNetworkId,
      nearMasterAccount,
      nearAPI.KeyPair.fromString(nearMasterSk)
    )
    await keyStore.setKey(
      nearNetworkId,
      nearTokenFactoryAccount,
      nearAPI.KeyPair.fromString(nearTokenFactorySk)
    )
    const near = await nearAPI.connect({
      nodeUrl: nearNodeUrl,
      networkId: nearNetworkId,
      masterAccount: nearMasterAccount,
      deps: { keyStore: keyStore }
    })

    await verifyAccount(near, nearMasterAccount)
    await verifyAccount(near, nearTokenFactoryAccount)

    console.log('Adding token ' + tokenName + ' at ' + ethTokenAddress)

    const tokenFactoryContract = new nearAPI.Contract(
      new nearAPI.Account(near.connection, nearTokenFactoryAccount),
      nearTokenFactoryAccount,
      {
        changeMethods: ['deploy_bridge_token'],
        viewMethods: ['get_bridge_token_account_id']
      }
    )

    try {
      // Try initializing the contract.
      await tokenFactoryContract.deploy_bridge_token(
        {
          address: remove0x(ethTokenAddress)
        },
        new BN('300000000000000'),
        new BN('3000000000000000000000000')
      )
    } catch (err) {
      console.log(
        `Failed to initialize the token ${tokenName} contract: ${err}`
      )
      process.exit(1)
    }
    console.log(`${tokenName} deployed`)

    return {
      nearTokenFactorySk,
      nearTokenAccount: remove0x(ethTokenAddress) + '.' + nearTokenFactoryAccount,
      ethTokenAddress
    }
  }
}

module.exports = { DeployToken }
