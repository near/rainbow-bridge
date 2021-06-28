const BN = require('bn.js')
const blockFromRpc = require('ethereumjs-block/from-rpc')
const utils = require('ethereumjs-util')
const {
  Web3,
  BorshContract,
  hexToBuffer,
  readerToHex
} = require('rainbow-bridge-utils')
const roots = require('./dag_merkle_roots.json')

function web3BlockToRlp (blockData) {
  // difficulty is only used and make sense in PoW network
  blockData.difficulty = parseInt(blockData.difficulty || '0', 10)
  blockData.totalDifficulty = parseInt(blockData.totalDifficulty, 10)
  blockData.uncleHash = blockData.sha3Uncles
  blockData.coinbase = blockData.miner
  blockData.transactionTrie = blockData.transactionsRoot
  blockData.receiptTrie = blockData.receiptsRoot
  blockData.bloom = blockData.logsBloom
  const blockHeader = blockFromRpc(blockData)
  return utils.rlp.encode(blockHeader.header.raw)
}

const borshSchema = {
  bool: {
    kind: 'function',
    ser: (b) => Buffer.from(Web3.utils.hexToBytes(b ? '0x01' : '0x00')),
    deser: (z) => readerToHex(1)(z) === '0x01'
  },
  initInput: {
    kind: 'struct',
    fields: [
      ['validate_header', 'bool'],
      ['validate_header_mode', 'string'],
      ['dags_start_epoch', 'u64'],
      ['dags_merkle_roots', ['H128']],
      ['first_header', ['u8']],
      ['hashes_gc_threshold', 'u64'],
      ['finalized_gc_threshold', 'u64'],
      ['num_confirmations', 'u64'],
      ['trusted_signer', '?AccountId'],
      ['chain_id', 'u64']
    ]
  },
  dagMerkleRootInput: {
    kind: 'struct',
    fields: [['epoch', 'u64']]
  },
  addBlockHeaderInput: {
    kind: 'struct',
    fields: [
      ['block_header', ['u8']],
      ['dag_nodes', ['DoubleNodeWithMerkleProof']]
    ]
  },
  DoubleNodeWithMerkleProof: {
    kind: 'struct',
    fields: [
      ['dag_nodes', ['H512']],
      ['proof', ['H128']]
    ]
  },
  H128: {
    kind: 'function',
    ser: hexToBuffer,
    deser: readerToHex(16)
  },
  H256: {
    kind: 'function',
    ser: hexToBuffer,
    deser: readerToHex(32)
  },
  H512: {
    kind: 'function',
    ser: hexToBuffer,
    deser: readerToHex(64)
  },
  '?H256': {
    kind: 'option',
    type: 'H256'
  },
  '?AccountId': {
    kind: 'option',
    type: 'string'
  }
}

class EthOnNearClientContract extends BorshContract {
  constructor (account, contractId) {
    super(borshSchema, account, contractId, {
      viewMethods: [
        {
          methodName: 'initialized',
          inputFieldType: null,
          outputFieldType: 'bool'
        },
        {
          methodName: 'dag_merkle_root',
          inputFieldType: 'dagMerkleRootInput',
          outputFieldType: 'H128'
        },
        {
          methodName: 'last_block_number',
          inputFieldType: null,
          outputFieldType: 'u64'
        },
        {
          methodName: 'block_hash',
          inputFieldType: 'u64',
          outputFieldType: '?H256'
        },
        {
          methodName: 'known_hashes',
          inputFieldType: 'u64',
          outputFieldType: ['H256']
        },
        {
          methodName: 'block_hash_safe',
          inputFieldType: 'u64',
          outputFieldType: '?H256'
        }
      ],

      changeMethods: [
        {
          methodName: 'init',
          inputFieldType: 'initInput',
          outputFieldType: null
        },
        {
          methodName: 'add_block_header',
          inputFieldType: 'addBlockHeaderInput',
          outputFieldType: null
        }
      ]
    })
  }

  // Call initialization methods on the contract.
  // If validateHeader is true will do header validation otherwise it won't.
  async maybeInitialize (hashesGcThreshold, finalizedGcThreshold, numConfirmations, validateHeader, validateHeaderMode, trustedSigner, chainID, robustWeb3) {
    await this.accessKeyInit()
    let initialized = false
    try {
      initialized = await this.initialized()
    } catch (e) {}
    if (!initialized) {
      console.log('EthOnNearClient is not initialized, initializing...')
      let lastBlockNumber = await robustWeb3.getBlockNumber()

      // if validateHeaderMode is bsc(POSA) we have to get the last epoch header
      if (validateHeaderMode === 'bsc' && lastBlockNumber % 200 !== 0) {
        lastBlockNumber = lastBlockNumber - lastBlockNumber % 200
      }

      const blockRlp = web3BlockToRlp(
        await robustWeb3.getBlock(lastBlockNumber)
      )
      await this.init(
        {
          validate_header: validateHeader,
          validate_header_mode: validateHeaderMode,
          dags_start_epoch: 0,
          dags_merkle_roots: roots.dag_merkle_roots,
          first_header: blockRlp,
          hashes_gc_threshold: hashesGcThreshold,
          finalized_gc_threshold: finalizedGcThreshold,
          num_confirmations: numConfirmations,
          trusted_signer: trustedSigner,
          chain_id: chainID
        },
        new BN('300000000000000')
      )
      console.log('EthOnNearClient initialized')
    }

    console.log('Checking EthOnNearClient initialization.')
    const firstRoot = await this.dag_merkle_root({
      epoch: 0
    })
    const lastRoot = await this.dag_merkle_root({
      epoch: 511
    })
    if (
      !(
        firstRoot === '0x55b891e842e58f58956a847cbbf67821' &&
        lastRoot === '0x7a9010568819de327a24fa495029adcb'
      )
    ) {
      console.log(
        `EthOnNearClient initialization error! The first and last roots are ${firstRoot} and ${lastRoot}`
      )
      process.exit(1)
    }
  }
}

exports.EthOnNearClientContract = EthOnNearClientContract
exports.web3BlockToRlp = web3BlockToRlp
exports.borshSchema = borshSchema
