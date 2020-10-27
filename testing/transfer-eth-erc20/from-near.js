const BN = require('bn.js')
const fs = require('fs')
// const assert = require('bsert')
const bs58 = require('bs58')
const { toBuffer } = require('eth-util-lite')
const {
  nearAPI,
  verifyAccount,
  RainbowConfig,
  borshifyOutcomeProof,
  sleep,
  RobustWeb3,
  normalizeEthKey,
  backoff,
  nearJsonContractFunctionCall
} = require('rainbow-bridge-utils')
const { tokenAddressParam, tokenAccountParam } = require('./deploy-token')
const { NearMintableToken } = require('./near-mintable-token')

let initialCmd

class TransferEthERC20FromNear {
  static showRetryAndExit () {
    console.log('Retry with command:')
    console.log(initialCmd)
    process.exit(1)
  }

  static parseBuffer (obj) {
    for (const i in obj) {
      if (obj[i] && obj[i].type === 'Buffer') {
        obj[i] = Buffer.from(obj[i].data)
      } else if (obj[i] && typeof obj[i] === 'object') {
        obj[i] = TransferEthERC20FromNear.parseBuffer(obj[i])
      }
    }
    return obj
  }

  static loadTransferLog () {
    try {
      const log =
        JSON.parse(
          fs.readFileSync('transfer-eth-erc20-from-near.log.json').toString()
        ) || {}
      return TransferEthERC20FromNear.parseBuffer(log)
    } catch (e) {
      return {}
    }
  }

  static deleteTransferLog () {
    try {
      fs.unlinkSync('transfer-eth-erc20-from-near.log.json')
    } catch (e) {
      console.log('Warning: failed to remove tranfer log')
    }
  }

  static recordTransferLog (obj) {
    fs.writeFileSync(
      'transfer-eth-erc20-from-near.log.json',
      JSON.stringify(obj)
    )
  }

  static async withdraw ({
    nearTokenContract,
    nearSenderAccountId,
    tokenAccount,
    amount,
    ethReceiverAddress,
    nearSenderAccount
  }) {
    // Withdraw the token on Near side.
    try {
      const oldBalance = await backoff(10, () =>
        nearTokenContract.get_balance({
          owner_id: nearSenderAccountId
        })
      )
      console.log(
        `Balance of ${nearSenderAccountId} before withdrawing: ${oldBalance}`
      )

      console.log(
        `Withdrawing ${amount} tokens on NEAR blockchain in favor of ${ethReceiverAddress}.`
      )
      const txWithdraw = await nearJsonContractFunctionCall(
        tokenAccount,
        nearSenderAccount,
        'withdraw',
        { amount: amount, recipient: ethReceiverAddress },
        new BN('300000000000000'),
        new BN(0)
      )
      console.log(`tx withdraw: ${JSON.stringify(txWithdraw)}`)

      TransferEthERC20FromNear.recordTransferLog({
        finished: 'withdraw',
        txWithdraw
      })
    } catch (txRevertMessage) {
      console.log('Failed to withdraw.')
      console.log(txRevertMessage.toString())
      TransferEthERC20FromNear.showRetryAndExit()
    }
  }

  static async findWithdrawInBlock ({ txWithdraw, nearSenderAccountId, near }) {
    try {
      let txReceiptId
      let txReceiptBlockHash
      let idType
      /* assert(
        RainbowConfig.getParam('near-token-factory-account') !== nearSenderAccountId
      ) */

      // Getting 1st tx
      const receipts = txWithdraw.transaction_outcome.outcome.receipt_ids
      if (receipts.length === 1) {
        txReceiptId = receipts[0]
        idType = 'receipt'
      } else {
        throw new Error(
          `Fungible token transaction call is expected to produce only one receipt, but produced: ${JSON.stringify(
            txWithdraw
          )}`
        )
      }

      // Getting 2nd tx
      try {
        txReceiptId = txWithdraw.receipts_outcome.find(
          (el) => el.id === txReceiptId
        ).outcome.status.SuccessReceiptId
        txReceiptBlockHash = txWithdraw.receipts_outcome.find(
          (el) => el.id === txReceiptId
        ).block_hash
      } catch (e) {
        throw new Error(`Invalid tx withdraw: ${JSON.stringify(txWithdraw)}`, e)
      }

      // Get block in which the receipt was processed.
      const receiptBlock = await backoff(10, () =>
        near.connection.provider.block({
          blockId: txReceiptBlockHash
        })
      )
      // Now wait for a final block with a strictly greater height. This block (or one of its ancestors) should hold the outcome, although this is not guaranteed if there are multiple shards.
      const outcomeBlock = await backoff(10, async () => {
        while (true) {
          const block = await near.connection.provider.block({
            finality: 'final'
          })
          if (
            Number(block.header.height) <= Number(receiptBlock.header.height)
          ) {
            await sleep(1000)
            continue
          }
          return block
        }
      })
      TransferEthERC20FromNear.recordTransferLog({
        finished: 'find-withdraw',
        txReceiptBlockHash,
        txReceiptId,
        outcomeBlock,
        idType
      })
    } catch (txRevertMessage) {
      console.log('Failed to find withdraw in block.')
      console.log(txRevertMessage.toString())
      TransferEthERC20FromNear.showRetryAndExit()
    }
  }

  static async waitBlock ({
    clientContract,
    outcomeBlock,
    robustWeb3,
    nearSenderAccountId,
    nearTokenContract,
    amount,
    idType,
    txReceiptId
  }) {
    // Wait for the block with the given receipt/transaction in Near2EthClient.
    try {
      const outcomeBlockHeight = Number(outcomeBlock.header.height)
      let clientBlockHeight
      let clientBlockHash
      while (true) {
        const clientState = await clientContract.methods.bridgeState().call()
        clientBlockHeight = Number(clientState.currentHeight)
        const clientBlockValidAfter = Number(clientState.nextValidAt)
        clientBlockHash = bs58.encode(
          toBuffer(
            await clientContract.methods.blockHashes(clientBlockHeight).call()
          )
        )

        console.log(
          `Current light client head is: hash=${clientBlockHash}, height=${clientBlockHeight}`
        )

        if (clientBlockHeight > outcomeBlockHeight) {
          console.log(
            `The block at height ${outcomeBlockHeight} is already available to the client.`
          )
          break
        } else {
          let delay =
            clientBlockValidAfter === 0
              ? await clientContract.methods.lockDuration().call()
              : clientBlockValidAfter -
                (await robustWeb3.getBlock('latest')).timestamp
          delay = Math.max(delay, 1)
          console.log(
            `Block ${outcomeBlockHeight} is not yet available. Sleeping for ${delay} seconds.`
          )
          await sleep(delay * 1000)
        }
      }
      console.log(`Withdrawn ${JSON.stringify(amount)}`)
      const newBalance = await backoff(10, () =>
        nearTokenContract.get_balance({
          owner_id: nearSenderAccountId
        })
      )
      console.log(
        `Balance of ${nearSenderAccountId} after withdrawing: ${newBalance}`
      )
      TransferEthERC20FromNear.recordTransferLog({
        finished: 'wait-block',
        clientBlockHashB58: clientBlockHash,
        idType,
        txReceiptId,
        clientBlockHeight
      })
    } catch (txRevertMessage) {
      console.log('Failed to wait for block occur in near on eth contract')
      console.log(txRevertMessage.toString())
      TransferEthERC20FromNear.showRetryAndExit()
    }
  }

  static async getProof ({
    idType,
    near,
    txReceiptId,
    nearSenderAccountId,
    clientBlockHashB58,
    clientBlockHeight
  }) {
    try {
      // Get the outcome proof only use block merkle root that we know is available on the Near2EthClient.
      let proofRes
      if (idType === 'transaction') {
        proofRes = await near.connection.provider.sendJsonRpc(
          'light_client_proof',
          {
            type: 'transaction',
            transaction_hash: txReceiptId,
            // TODO: Use proper sender.
            receiver_id: nearSenderAccountId,
            light_client_head: clientBlockHashB58
          }
        )
      } else if (idType === 'receipt') {
        proofRes = await near.connection.provider.sendJsonRpc(
          'light_client_proof',
          {
            type: 'receipt',
            receipt_id: txReceiptId,
            // TODO: Use proper sender.
            receiver_id: nearSenderAccountId,
            light_client_head: clientBlockHashB58
          }
        )
      } else {
        throw new Error('Unreachable')
      }
      TransferEthERC20FromNear.recordTransferLog({
        finished: 'get-proof',
        proofRes,
        clientBlockHeight
      })
    } catch (txRevertMessage) {
      console.log('Failed to get proof.')
      console.log(txRevertMessage.toString())
      TransferEthERC20FromNear.showRetryAndExit()
    }
  }

  static async unlock ({
    proverContract,
    proofRes,
    clientBlockHeight,
    ethERC20Contract,
    ethReceiverAddress,
    ethTokenLockerContract,
    ethMasterAccount,
    robustWeb3
  }) {
    try {
      // Check that the proof is correct.
      const borshProofRes = borshifyOutcomeProof(proofRes)
      clientBlockHeight = new BN(clientBlockHeight)
      // Debugging output, uncomment for debugging.
      // console.log(`proof: ${JSON.stringify(proofRes)}`);
      // console.log(`client height: ${clientBlockHeight.toString()}`);
      // console.log(`root: ${clientBlockMerkleRoot}`);
      await proverContract.methods
        .proveOutcome(borshProofRes, clientBlockHeight)
        .call()

      const oldBalance = await ethERC20Contract.methods
        .balanceOf(ethReceiverAddress)
        .call()
      console.log(
        `ERC20 balance of ${ethReceiverAddress} before the transfer: ${oldBalance}`
      )
      await robustWeb3.callContract(
        ethTokenLockerContract,
        'unlockToken',
        [borshProofRes, clientBlockHeight],
        {
          from: ethMasterAccount,
          gas: 5000000,
          handleRevert: true,
          gasPrice: new BN(await robustWeb3.web3.eth.getGasPrice()).mul(
            new BN(RainbowConfig.getParam('eth-gas-multiplier'))
          )
        }
      )
      /* await ethTokenLockerContract.methods
        .unlockToken(borshProofRes, clientBlockHeight)
        .send({
          from: ethMasterAccount,
          gas: 5000000,
          handleRevert: true,
          gasPrice: new BN(await robustWeb3.web3.eth.getGasPrice()).mul(
            new BN(RainbowConfig.getParam('eth-gas-multiplier'))
          ),
        }) */
      const newBalance = await ethERC20Contract.methods
        .balanceOf(ethReceiverAddress)
        .call()
      console.log(
        `ERC20 balance of ${ethReceiverAddress} after the transfer: ${newBalance}`
      )

      TransferEthERC20FromNear.deleteTransferLog()
    } catch (txRevertMessage) {
      console.log('Failed to unlock.')
      console.log(txRevertMessage.toString())
      TransferEthERC20FromNear.showRetryAndExit()
    }
  }

  static async execute (command) {
    initialCmd = command.parent.rawArgs.join(' ')
    const nearSenderAccountId = command.nearSenderAccount
    const amount = command.amount
    const ethReceiverAddress = command.ethReceiverAddress.startsWith('0x')
      ? command.ethReceiverAddress.substr(2)
      : command.ethReceiverAddress
    const tokenAddress = command.tokenName
      ? RainbowConfig.getParam(tokenAddressParam(command.tokenName))
      : RainbowConfig.getParam('eth-erc20-address')
    const tokenAccount = command.tokenName
      ? RainbowConfig.getParam(tokenAccountParam(command.tokenName))
      : RainbowConfig.getParam('near-erc20-account')

    const keyStore = new nearAPI.keyStores.InMemoryKeyStore()
    await keyStore.setKey(
      RainbowConfig.getParam('near-network-id'),
      nearSenderAccountId,
      nearAPI.KeyPair.fromString(command.nearSenderSk)
    )
    const near = await nearAPI.connect({
      nodeUrl: RainbowConfig.getParam('near-node-url'),
      networkId: RainbowConfig.getParam('near-network-id'),
      masterAccount: nearSenderAccountId,
      deps: { keyStore: keyStore }
    })
    const nearSenderAccount = new nearAPI.Account(
      near.connection,
      nearSenderAccountId
    )
    await verifyAccount(near, nearSenderAccountId)

    const nearTokenContract = new nearAPI.Contract(
      nearSenderAccount,
      tokenAccount,
      {
        changeMethods: ['new', 'withdraw'],
        viewMethods: ['get_balance']
      }
    )
    const nearTokenContractBorsh = new NearMintableToken(
      nearSenderAccount,
      tokenAccount
    )
    await nearTokenContractBorsh.accessKeyInit()

    const robustWeb3 = new RobustWeb3(RainbowConfig.getParam('eth-node-url'))
    const web3 = robustWeb3.web3
    let ethMasterAccount = web3.eth.accounts.privateKeyToAccount(
      normalizeEthKey(RainbowConfig.getParam('eth-master-sk'))
    )
    web3.eth.accounts.wallet.add(ethMasterAccount)
    web3.eth.defaultAccount = ethMasterAccount.address
    ethMasterAccount = ethMasterAccount.address
    const clientContract = new web3.eth.Contract(
      // @ts-ignore
      JSON.parse(
        fs.readFileSync(RainbowConfig.getParam('eth-client-abi-path'))
      ),
      RainbowConfig.getParam('eth-client-address'),
      {
        from: ethMasterAccount,
        handleRevert: true
      }
    )
    const proverContract = new web3.eth.Contract(
      // @ts-ignore
      JSON.parse(
        fs.readFileSync(RainbowConfig.getParam('eth-prover-abi-path'))
      ),
      RainbowConfig.getParam('eth-prover-address'),
      {
        from: ethMasterAccount,
        handleRevert: true
      }
    )
    const ethTokenLockerContract = new web3.eth.Contract(
      // @ts-ignore
      JSON.parse(
        fs.readFileSync(RainbowConfig.getParam('eth-locker-abi-path'))
      ),
      RainbowConfig.getParam('eth-locker-address'),
      {
        from: ethMasterAccount,
        handleRevert: true
      }
    )
    const ethERC20Contract = new web3.eth.Contract(
      // @ts-ignore
      JSON.parse(fs.readFileSync(RainbowConfig.getParam('eth-erc20-abi-path'))),
      tokenAddress,
      {
        from: ethMasterAccount,
        handleRevert: true
      }
    )

    let transferLog = TransferEthERC20FromNear.loadTransferLog()
    if (transferLog.finished === undefined) {
      await TransferEthERC20FromNear.withdraw({
        nearTokenContract,
        nearSenderAccountId,
        tokenAccount,
        amount,
        ethReceiverAddress,
        nearSenderAccount
      })
      transferLog = TransferEthERC20FromNear.loadTransferLog()
    }
    if (transferLog.finished === 'withdraw') {
      await TransferEthERC20FromNear.findWithdrawInBlock({
        txWithdraw: transferLog.txWithdraw,
        nearSenderAccountId,
        near
      })
      transferLog = TransferEthERC20FromNear.loadTransferLog()
    }
    if (transferLog.finished === 'find-withdraw') {
      await TransferEthERC20FromNear.waitBlock({
        clientContract,
        robustWeb3,
        outcomeBlock: transferLog.outcomeBlock,
        nearSenderAccountId,
        nearTokenContract,
        amount,
        idType: transferLog.idType,
        txReceiptId: transferLog.txReceiptId
      })
      transferLog = TransferEthERC20FromNear.loadTransferLog()
    }
    if (transferLog.finished === 'wait-block') {
      await TransferEthERC20FromNear.getProof({
        idType: transferLog.idType,
        near,
        txReceiptId: transferLog.txReceiptId,
        nearSenderAccountId,
        clientBlockHashB58: transferLog.clientBlockHashB58,
        clientBlockHeight: transferLog.clientBlockHeight
      })
      transferLog = TransferEthERC20FromNear.loadTransferLog()
    }
    if (transferLog.finished === 'get-proof') {
      await TransferEthERC20FromNear.unlock({
        proverContract,
        proofRes: transferLog.proofRes,
        clientBlockHeight: transferLog.clientBlockHeight,
        ethERC20Contract,
        ethReceiverAddress,
        ethTokenLockerContract,
        ethMasterAccount,
        robustWeb3
      })
    }

    process.exit(0)
  }
}

exports.TransferEthERC20FromNear = TransferEthERC20FromNear