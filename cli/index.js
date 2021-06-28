#!/usr/bin/env node
const path = require('path')
const changeCase = require('change-case')
const { program } = require('commander')

const { CleanCommand } = require('./commands/clean')
const { PrepareCommand } = require('./commands/prepare')
const { StatusCommand } = require('./commands/status')
const {
  StartEth2NearRelayCommand
} = require('./commands/start/eth2near-relay.js')
const {
  StartNear2EthRelayCommand
} = require('./commands/start/near2eth-relay.js')
const { StartWatchdogCommand } = require('./commands/start/watchdog.js')
const { StartGanacheNodeCommand } = require('./commands/start/ganache.js')
const { StartBinanceSmartChainNodeCommand } = require('./commands/start/binance-smart-chain.js')
const { StartLocalNearNodeCommand } = require('./commands/start/near.js')
const { AddressWatcherCommand } = require('./commands/start/address-watcher.js')
const { StopManagedProcessCommand } = require('./commands/stop/process.js')
const {
  DangerSubmitInvalidNearBlock
} = require('./commands/danger-submit-invalid-near-block')
const { DangerDeployMyERC20 } = require('./commands/danger-deploy-myerc20')
const {
  TransferETHERC20ToNear,
  TransferEthERC20FromNear,
  DeployToken,
  mintErc20,
  getErc20Balance,
  getBridgeOnNearBalance,
  getClientBlockHeightHash,
  getAddressBySecretKey,
  ethToNearApprove,
  ethToNearLock,
  nearToEthUnlock
} = require('rainbow-bridge-testing')
const { ETHDump } = require('./commands/eth-dump')
const { NearDump } = require('./commands/near-dump')
const { ethToNearFindProof } = require('rainbow-bridge-eth2near-block-relay')
const { RainbowConfig } = require('rainbow-bridge-utils')
const {
  InitNearContracts,
  InitNearTokenFactory,
  InitEthEd25519,
  InitEthErc20,
  InitEthLocker,
  InitEthClient,
  InitEthProver
} = require('./init')

// source dir or where rainbow cli is installed (when install with npm)
// TODO @frol use config
const BRIDGE_SRC_DIR = __dirname
const LIBS_SOL_SRC_DIR = path.join(BRIDGE_SRC_DIR, '..', 'contracts', 'eth')
const LIBS_RS_SRC_DIR = path.join(BRIDGE_SRC_DIR, '..', 'contracts', 'near')
const LIBS_TC_SRC_DIR = path.join(BRIDGE_SRC_DIR, '..', 'node_modules', 'rainbow-token-connector')

RainbowConfig.declareOption(
  'near-network-id',
  'The identifier of the NEAR network that the given NEAR node is expected to represent.'
)
RainbowConfig.declareOption('near-node-url', 'The URL of the NEAR node.')
RainbowConfig.declareOption('eth-node-url', 'The URL of the Ethereum node.')
RainbowConfig.declareOption(
  'near-master-account',
  'The account of the master account on NEAR blockchain that can be used to deploy and initialize the test contracts.' +
    ' This account will also own the initial supply of the fungible tokens.'
)
RainbowConfig.declareOption(
  'near-master-sk',
  'The secret key of the master account on NEAR blockchain.'
)
RainbowConfig.declareOption(
  'eth-master-sk',
  'The secret key of the master account on Ethereum blockchain.'
)
RainbowConfig.declareOption(
  'near-client-account',
  'The account of the Near Client contract that can be used to accept ETH headers.',
  'rainbow_bridge_eth_on_near_client'
)
RainbowConfig.declareOption(
  'near-client-sk',
  'The secret key of the Near Client account. If not specified will use master SK.'
)
RainbowConfig.declareOption(
  'near-client-contract-path',
  'The path to the Wasm file containing the Near Client contract.',
  path.join(LIBS_RS_SRC_DIR, 'res/eth_client.wasm')
)
RainbowConfig.declareOption(
  'near-client-init-balance',
  'The initial balance of Near Client contract in yoctoNEAR.',
  '100000000000000000000000000'
)
RainbowConfig.declareOption(
  'near-client-validate-header',
  'Whether validate header of submitted eth block, should set to true on mainnet(s) and false on PoA testnets',
  'true'
)

RainbowConfig.declareOption(
  'near-client-validate-header-mode',
  'Choose between ethash and bsc',
  'ethash'
)
RainbowConfig.declareOption(
  'hashes-gc-threshold',
  'Events that happen past this threshold cannot be verified by the client.',
  40000
)
RainbowConfig.declareOption(
  'finalized-gc-threshold',
  'We store full information about the headers for the past `finalized_gc_threshold` blocks.',
  500
)
// TODO: https://github.com/near/rainbow-bridge/issues/388
// Move the number of confirmation out of the prover, and let each application
// decide that parameter considering if they prefer fast finality or higher confidence of inclusion.
RainbowConfig.declareOption(
  'num-confirmations',
  'Number of confirmations blocks on Ethereum that applications can use to consider the transaction safe.',
  30
)
RainbowConfig.declareOption(
  'near-client-trusted-signer',
  'When non empty, deploy as trusted-signer mode where only trusted signer can submit blocks to client',
  ''
)
RainbowConfig.declareOption(
  'near-prover-account',
  'The account of the Near Prover contract that can be used to accept ETH headers.',
  'rainbow_bridge_eth_on_near_prover'
)
RainbowConfig.declareOption(
  'near-prover-sk',
  'The secret key of the Near Prover account. If not specified will use master SK.'
)
RainbowConfig.declareOption(
  'near-prover-contract-path',
  'The path to the Wasm file containing the Near Prover contract.',
  path.join(LIBS_RS_SRC_DIR, 'res/eth_prover.wasm')
)
RainbowConfig.declareOption(
  'near-prover-init-balance',
  'The initial balance of Near Prover contract in yoctoNEAR.',
  '100000000000000000000000000'
)
RainbowConfig.declareOption(
  'daemon',
  'Whether the process should be launched as a daemon.',
  'true',
  true
)
RainbowConfig.declareOption(
  'core-src',
  'Path to the nearcore source. It will be downloaded if not provided.',
  ''
)
RainbowConfig.declareOption(
  'eth-gas-multiplier',
  'How many times more in Ethereum gas are we willing to overpay.',
  '1'
)
RainbowConfig.declareOption(
  'metrics-port',
  'On which port to expose metrics for corresponding relayer, if not provided no metrics exposed',
  null
)

// User-specific arguments.
RainbowConfig.declareOption(
  'near-token-factory-account',
  'The account of the token factory contract that will be used to mint tokens locked on Ethereum.',
  'neartokenfactory'
)
RainbowConfig.declareOption(
  'near-token-factory-sk',
  'The secret key of the token factory account. If not specified will use master SK.'
)
RainbowConfig.declareOption(
  'near-token-factory-contract-path',
  'The path to the Wasm file containing the token factory contract.',
  path.join(LIBS_TC_SRC_DIR, 'res/bridge_token_factory.wasm')
)
RainbowConfig.declareOption(
  'near-token-factory-init-balance',
  'The initial balance of token factory contract in yoctoNEAR.',
  '1000000000000000000000000000'
)
RainbowConfig.declareOption(
  'eth-locker-address',
  'ETH address of the locker contract.'
)
RainbowConfig.declareOption(
  'eth-locker-abi-path',
  'Path to the .abi file defining Ethereum locker contract. This contract works in pair with mintable fungible token on NEAR blockchain.',
  path.join(LIBS_TC_SRC_DIR, 'res/ERC20Locker.full.abi')
)
RainbowConfig.declareOption(
  'eth-locker-bin-path',
  'Path to the .bin file defining Ethereum locker contract. This contract works in pair with mintable fungible token on NEAR blockchain.',
  path.join(LIBS_TC_SRC_DIR, 'res/ERC20Locker.full.bin')
)
RainbowConfig.declareOption(
  'eth-erc20-address',
  'ETH address of the ERC20 contract.'
)
RainbowConfig.declareOption(
  'eth-erc20-abi-path',
  'Path to the .abi file defining Ethereum ERC20 contract.',
  path.join(LIBS_TC_SRC_DIR, 'res/TToken.full.abi')
)
RainbowConfig.declareOption(
  'eth-erc20-bin-path',
  'Path to the .bin file defining Ethereum ERC20 contract.',
  path.join(LIBS_TC_SRC_DIR, 'res/TToken.full.bin')
)
RainbowConfig.declareOption(
  'eth-ed25519-address',
  'ETH address of the ED25519 contract.'
)
RainbowConfig.declareOption(
  'eth-ed25519-artifact-path',
  'Path to the artifact file defining Ethereum ED25519 contract.',
  path.join(LIBS_SOL_SRC_DIR, 'nearbridge/artifacts/contracts/Ed25519.sol/Ed25519.json')
)
RainbowConfig.declareOption(
  'eth-client-lock-eth-amount',
  'Amount of Ether that should be temporarily locked when submitting a new header to EthClient, in wei.',
  '100000000000000000000'
)
RainbowConfig.declareOption(
  'eth-client-lock-duration',
  'The challenge window during which anyone can challenge an incorrect ED25519 signature of the Near block, in EthClient, in seconds.',
  14400
)
RainbowConfig.declareOption(
  'eth-client-replace-duration',
  'Minimum time difference required to replace a block during challenge period, in EthClient, in seconds.',
  18000
)
RainbowConfig.declareOption(
  'eth-client-address',
  'ETH address of the EthClient contract.'
)
RainbowConfig.declareOption(
  'eth-client-artifact-path',
  'Path to the artifact file defining Ethereum Client contract.',
  path.join(LIBS_SOL_SRC_DIR, 'nearbridge/artifacts/contracts/NearBridge.sol/NearBridge.json')
)
RainbowConfig.declareOption(
  'eth-admin-address',
  'ETH address of the administrator for locker contract. It is used for upgradeability purposes. If empty, used address of eth-master-sk.'
)
// TODO: Add example of json file with description of accounts to be watched.
RainbowConfig.declareOption(
  'monitor-accounts-path',
  'Path to all accounts on NEAR and Ethereum side to monitor. Ignored if not specified.',
  ''
)
RainbowConfig.declareOption(
  'eth-prover-address',
  'ETH address of the EthProver contract.'
)
RainbowConfig.declareOption(
  'eth-prover-artifact-path',
  'Path to the artifact file defining Ethereum Prover contract.',
  path.join(LIBS_SOL_SRC_DIR, 'nearprover/artifacts/contracts/NearProver.sol/NearProver.json')
)
RainbowConfig.declareOption(
  'near2eth-relay-min-delay',
  "Minimum number of seconds to wait if the relay can't submit a block right away.",
  '1'
)
RainbowConfig.declareOption(
  'near2eth-relay-max-delay',
  "Maximum number of seconds to wait if the relay can't submit a block right away.",
  '600'
)
RainbowConfig.declareOption(
  'near2eth-relay-error-delay',
  'Number of seconds to wait before retrying if there is an error.',
  '1'
)
RainbowConfig.declareOption(
  'watchdog-delay',
  'Number of seconds to wait after validating all signatures.',
  '300'
)
RainbowConfig.declareOption(
  'watchdog-error-delay',
  'Number of seconds to wait before retrying if there is an error.',
  '1'
)
RainbowConfig.declareOption('near-erc20-account', 'Must be declared before set')
RainbowConfig.declareOption('total-submit-block', 'Number of blocks to submit on each batch update from Ethereum to NEAR', 4)
RainbowConfig.declareOption('gas-per-transaction', 'Maximum gas per transaction add_block_header', '72000000000000')
RainbowConfig.declareOption('archival', 'Start Near node in archival mode (no garbage collection)', 'false')

program.version(require('./package.json').version)

// General-purpose commands.
program.command('clean').action(CleanCommand.execute)

RainbowConfig.addOptions(
  program.command('prepare'),
  PrepareCommand.execute,
  ['core-src']
)

RainbowConfig.addOptions(
  program.command('status'),
  StatusCommand.execute,
  [
    'near-network-id',
    'near-node-url',
    'near-master-account',
    'near-master-sk',
    'near-client-account',
    'near-client-sk',
    'near-prover-account',
    'near-prover-sk',
    'eth-node-url',
    'eth-master-sk'
  ]
)

// Maintainer commands.
const startCommand = program.command('start')

RainbowConfig.addOptions(
  startCommand.command('near-node'),
  StartLocalNearNodeCommand.execute,
  ['archival']
)

RainbowConfig.addOptions(
  startCommand.command('ganache'),
  StartGanacheNodeCommand.execute,
  []
)

RainbowConfig.addOptions(
  startCommand.command('binance-smart-chain'),
  StartBinanceSmartChainNodeCommand.execute,
  [
    'eth-node-url',
    'eth-master-sk',
    'near-client-validate-header'
  ]
)

RainbowConfig.addOptions(
  startCommand.command('eth2near-relay'),
  StartEth2NearRelayCommand.execute,
  [
    'near-master-account',
    'near-master-sk',
    'near-client-account',
    'near-network-id',
    'near-node-url',
    'eth-node-url',
    'total-submit-block',
    'gas-per-transaction',
    'daemon',
    'metrics-port',
    'near-client-validate-header-mode'
  ]
)

RainbowConfig.addOptions(
  startCommand.command('near2eth-relay'),
  StartNear2EthRelayCommand.execute,
  [
    'eth-node-url',
    'eth-master-sk',
    'near-node-url',
    'near-network-id',
    'eth-client-artifact-path',
    'eth-client-address',
    'near2eth-relay-min-delay',
    'near2eth-relay-max-delay',
    'near2eth-relay-error-delay',
    'eth-gas-multiplier',
    'daemon',
    'metrics-port'
  ]
)

RainbowConfig.addOptions(
  startCommand.command('bridge-watchdog'),
  StartWatchdogCommand.execute,
  [
    'eth-node-url',
    'eth-master-sk',
    'eth-client-artifact-path',
    'eth-client-address',
    'watchdog-delay',
    'watchdog-error-delay',
    'daemon',
    'metrics-port'
  ]
)

RainbowConfig.addOptions(
  startCommand.command('address-watcher'),
  AddressWatcherCommand.execute,
  [
    'eth-node-url',
    'near-node-url',
    'near-network-id',
    'eth-master-sk',
    'near-client-account',
    'near-master-account',
    'monitor-accounts-path',
    'daemon',
    'metrics-port'
  ]
)

const stopCommand = program.command('stop')

RainbowConfig.addOptions(
  stopCommand.command('all'),
  StopManagedProcessCommand.execute,
  []
)

RainbowConfig.addOptions(
  stopCommand.command('near-node'),
  StopManagedProcessCommand.execute,
  []
)

RainbowConfig.addOptions(
  stopCommand.command('ganache'),
  StopManagedProcessCommand.execute,
  []
)

RainbowConfig.addOptions(
  stopCommand.command('eth2near-relay'),
  StopManagedProcessCommand.execute,
  [])

RainbowConfig.addOptions(
  stopCommand.command('near2eth-relay'),
  StopManagedProcessCommand.execute,
  []
)

RainbowConfig.addOptions(
  stopCommand.command('bridge-watchdog'),
  StopManagedProcessCommand.execute,
  []
)

RainbowConfig.addOptions(
  program
    .command('init-near-contracts')
    .description(
      'Deploys and initializes Near Client and Near Prover contracts to NEAR blockchain.'
    ),
  InitNearContracts.execute,
  [
    'near-network-id',
    'near-node-url',
    'eth-node-url',
    'near-master-account',
    'near-master-sk',
    'near-client-account',
    'near-client-sk',
    'near-client-contract-path',
    'near-client-init-balance',
    'near-client-validate-header',
    'near-client-validate-header-mode',
    'near-client-trusted-signer',
    'hashes-gc-threshold',
    'finalized-gc-threshold',
    'num-confirmations',
    'near-prover-account',
    'near-prover-sk',
    'near-prover-contract-path',
    'near-prover-init-balance'

  ]
)

RainbowConfig.addOptions(
  program
    .command('init-eth-ed25519')
    .description(
      'Deploys and initializes ED25519 Solidity contract. It replaces missing precompile.'
    ),
  InitEthEd25519.execute,
  [
    'eth-node-url',
    'eth-master-sk',
    'eth-ed25519-artifact-path',
    'eth-gas-multiplier'
  ]
)

RainbowConfig.addOptions(
  program
    .command('init-eth-client')
    .description('Deploys and initializes EthClient.'),
  InitEthClient.execute,
  [
    'eth-node-url',
    'eth-master-sk',
    'eth-client-artifact-path',
    'eth-admin-address',
    'eth-ed25519-address',
    'eth-client-lock-eth-amount',
    'eth-client-lock-duration',
    'eth-client-replace-duration',
    'eth-gas-multiplier'
  ]
)

RainbowConfig.addOptions(
  program
    .command('init-eth-prover')
    .description('Deploys and initializes EthProver.'),
  InitEthProver.execute,
  [
    'eth-node-url',
    'eth-master-sk',
    'eth-prover-artifact-path',
    'eth-admin-address',
    'eth-client-address',
    'eth-gas-multiplier'
  ]
)

// User commands.

RainbowConfig.addOptions(
  program
    .command('init-near-token-factory')
    .description(
      'Deploys and initializes token factory to NEAR blockchain. Requires locker on Ethereum side.'
    ),
  InitNearTokenFactory.execute,
  [
    'near-node-url',
    'near-network-id',
    'near-master-account',
    'near-master-sk',
    'near-prover-account',
    'near-token-factory-account',
    'near-token-factory-sk',
    'near-token-factory-contract-path',
    'near-token-factory-init-balance',
    'eth-locker-address',
    'eth-erc20-address'
  ]
)

RainbowConfig.addOptions(
  program
    .command('deploy-token <token_name> <eth_token_address>')
    .description('Deploys and initializes token on NEAR.'),
  async (tokenName, ethTokenAddress, args) => {
    const deployedTokenInfo = await DeployToken.execute({ tokenName, ethTokenAddress, ...args })
    if (!deployedTokenInfo) {
      return null
    }
    const {
      nearTokenAccount,
      ethTokenAddress: _,
      ...otherDeployedTokenInfo
    } = deployedTokenInfo
    return {
      [`near${changeCase.capitalCase(tokenName)}Account`]: nearTokenAccount,
      [`eth${changeCase.capitalCase(tokenName)}Address`]: ethTokenAddress,
      ...otherDeployedTokenInfo
    }
  },
  [
    'near-node-url',
    'near-network-id',
    'near-master-account',
    'near-master-sk',
    'near-token-factory-account',
    'near-token-factory-sk'
  ]
)

RainbowConfig.addOptions(
  program
    .command('init-eth-locker')
    .description(
      'Deploys and initializes locker contract on Ethereum blockchain. Requires token factory on Near side.'
    ),
  InitEthLocker.execute,
  [
    'near-token-factory-account',
    'eth-node-url',
    'eth-master-sk',
    'eth-locker-abi-path',
    'eth-locker-bin-path',
    'eth-admin-address',
    'eth-prover-address',
    'eth-gas-multiplier'
  ]
)

RainbowConfig.addOptions(
  program
    .command('init-eth-erc20')
    .description(
      'Deploys and initializes ERC20 contract on Ethereum blockchain.'
    ),
  InitEthErc20.execute,
  [
    'eth-node-url',
    'eth-master-sk',
    'eth-erc20-abi-path',
    'eth-erc20-bin-path',
    'eth-gas-multiplier'
  ]
)

RainbowConfig.addOptions(
  program
    .command('eth-to-near-find-proof <locked_event>')
    .description('Get eth-to-near proof by locked event.'),
  async (lockedEventRaw, args) => {
    await ethToNearFindProof({ lockedEventRaw, ...args })
  },
  [
    'eth-node-url'
  ]
)

// Testing commands
const testingCommand = program
  .command('TESTING')
  .description(
    'Commands that should only be used for testing purpose.'
  )

RainbowConfig.addOptions(
  testingCommand
    .command('transfer-eth-erc20-to-near')
    .option('--amount <amount>', 'Amount of ERC20 tokens to transfer')
    .option(
      '--eth-sender-sk <eth_sender_sk>',
      'The secret key of the Ethereum account that will be sending ERC20 token.'
    )
    .option(
      '--near-receiver-account <near_receiver_account>',
      'The account on NEAR blockchain that will be receiving the minted token.'
    )
    .option(
      '--token-name <token_name>',
      'Specific ERC20 token that is already bound by `deploy-token`.'
    ),
  ({ tokenName, ...args }) => {
    if (tokenName) {
      args.ethErc20Address = RainbowConfig.getParam(`eth-${tokenName}-address`)
      args.nearErc20Account = RainbowConfig.getParam(`near-${tokenName}-account`)
    }
    return TransferETHERC20ToNear.execute(args)
  },
  [
    'eth-erc20-address',
    'near-erc20-account',
    'eth-node-url',
    'eth-erc20-abi-path',
    'eth-locker-address',
    'eth-locker-abi-path',
    'near-node-url',
    'near-network-id',
    'near-token-factory-account',
    'near-client-account',
    'near-master-account',
    'near-master-sk'
  ]
)

RainbowConfig.addOptions(
  testingCommand
    .command('transfer-eth-erc20-from-near')
    .option('--amount <amount>', 'Amount of ERC20 tokens to transfer')
    .option(
      '--near-sender-account <near_sender_account>',
      'Near account that will be sending fungible token.'
    )
    .option(
      '--near-sender-sk <near_sender_sk>',
      'The secret key of Near account that will be sending the fungible token.'
    )
    .option(
      '--eth-receiver-address <eth_receiver_address>',
      'The account that will be receiving the token on Ethereum side.'
    )
    .option(
      '--token-name <token_name>',
      'Specific ERC20 token that is already bound by `deploy-token`.'
    ),
  ({ tokenName, ...args }) => {
    if (tokenName) {
      args.ethErc20Address = RainbowConfig.getParam(`eth-${tokenName}-address`)
      args.nearErc20Account = RainbowConfig.getParam(`near-${tokenName}-account`)
    }
    return TransferEthERC20FromNear.execute(args)
  },
  [
    'eth-erc20-address',
    'near-erc20-account',
    'near-node-url',
    'near-network-id',
    'near-token-factory-account',
    'eth-node-url',
    'eth-master-sk',
    'eth-erc20-abi-path',
    'eth-locker-address',
    'eth-locker-abi-path',
    'eth-client-artifact-path',
    'eth-client-address',
    'eth-prover-artifact-path',
    'eth-prover-address',
    'eth-gas-multiplier'
  ]
)

RainbowConfig.addOptions(
  testingCommand
    .command('mint-erc20-tokens <eth_account_address> <amount> <token_name>')
    .description('Mint ERC20 test token for specific account address'),
  async (ethAccountAddress, amount, tokenName, args) => {
    if (tokenName) {
      args.ethErc20Address = RainbowConfig.getParam(`eth-${tokenName}-address`)
    }
    await mintErc20({ ethAccountAddress, amount, ...args })
  },
  [
    'eth-node-url',
    'eth-erc20-address',
    'eth-erc20-abi-path'
  ]
)

RainbowConfig.addOptions(
  testingCommand
    .command('get-account-address <eth_secret_key>')
    .description('Get account address accessible by its secret key on Ethereum.'),
  async (ethSecretKey, args) => {
    await getAddressBySecretKey({ ethSecretKey, ...args })
  },
  [
    'eth-node-url'
  ]
)

RainbowConfig.addOptions(
  testingCommand
    .command('get-erc20-balance <eth_account_address>')
    .description('Get ERC20 balance on Ethereum for specific token (e.g. erc20).'),
  async (ethAccountAddress, args) => {
    console.log(
      `(Contract: ${args.ethErc20Address}) ERC20 balance of ${ethAccountAddress} is:`
    )
    await getErc20Balance({ ethAccountAddress, ...args })
  },
  [
    'eth-node-url',
    'eth-erc20-address',
    'eth-erc20-abi-path'
  ]
)

RainbowConfig.addOptions(
  testingCommand
    .command('get-bridge-on-near-balance')
    .option(
      '--near-receiver-account <near_receiver_account>',
      'The account on NEAR blockchain that owns bridged tokens.'
    )
    .description('Gets balance of bridged tokens from ETH to NEAR for the provided account.'),
  async (args) => {
    await getBridgeOnNearBalance(args)
  },
  [
    'near-erc20-account',
    'near-network-id',
    'near-node-url'
  ]
)

RainbowConfig.addOptions(
  testingCommand
    .command('get-client-block-height-hash')
    .description('Get last block height available on Eth client.'),
  async (args) => {
    await getClientBlockHeightHash(args)
  },
  [
    'eth-node-url',
    'eth-master-sk',
    'eth-client-artifact-path',
    'eth-client-address'
  ]
)

RainbowConfig.addOptions(
  testingCommand
    .command('eth-to-near-approve <eth_account_address> <amount> <token_name>')
    .description('Approve ERC20 token to lock'),
  async (ethAccountAddress, amount, tokenName, args) => {
    if (tokenName) {
      args.ethErc20Address = RainbowConfig.getParam(`eth-${tokenName}-address`)
    }
    await ethToNearApprove({ ethAccountAddress, amount, ...args })
  },
  [
    'eth-node-url',
    'eth-erc20-address',
    'eth-erc20-abi-path',
    'eth-locker-address'
  ]
)

RainbowConfig.addOptions(
  testingCommand
    .command('eth-to-near-lock <eth_account_address> <near_account_name> <amount> <token_name>')
    .description('Lock ERC20 tokens'),
  async (ethAccountAddress, nearAccountName, amount, tokenName, args) => {
    if (tokenName) {
      args.ethErc20Address = RainbowConfig.getParam(`eth-${tokenName}-address`)
    }
    await ethToNearLock({ ethAccountAddress, nearAccountName, amount, ...args })
  },
  [
    'eth-node-url',
    'eth-erc20-address',
    'eth-locker-abi-path',
    'eth-locker-address'
  ]
)

RainbowConfig.addOptions(
  testingCommand
    .command('near-to-eth-unlock <block_height> <proof>')
    .description('Unlock ERC20 tokens'),
  async (blockHeight, proof, args) => {
    await nearToEthUnlock({ blockHeight, proof, ...args })
  },
  [
    'eth-node-url',
    'eth-master-sk',
    'eth-locker-abi-path',
    'eth-locker-address',
    'eth-gas-multiplier'
  ]
)

// Danger Testing commands
const dangerCommand = program
  .command('DANGER')
  .description(
    'Dangerous commands that should only be used for testing purpose.'
  )

RainbowConfig.addOptions(
  dangerCommand
    .command('submit_invalid_near_block')
    .description(
      'Fetch latest near block, randomly mutate one byte and submit to NearBridge'
    ),
  DangerSubmitInvalidNearBlock.execute,
  [
    'eth-node-url',
    'eth-master-sk',
    'near-node-url',
    'near-network-id',
    'eth-client-artifact-path',
    'eth-client-address',
    'near2eth-relay-min-delay',
    'near2eth-relay-max-delay',
    'near2eth-relay-error-delay',
    'eth-gas-multiplier'
  ]
)

RainbowConfig.addOptions(
  dangerCommand
    .command('deploy_test_erc20')
    .description('Deploys MyERC20'),
  DangerDeployMyERC20.execute,
  [
    'eth-node-url',
    'eth-master-sk',
    'eth-erc20-abi-path',
    'eth-gas-multiplier'
  ]
)

RainbowConfig.addOptions(
  program
    .command('eth-dump <kind_of_data>')
    .option('--path <path>', 'Dir path to dump eth data')
    .option(
      '--start-block <start_block>',
      'Start block number (inclusive), default to be 4.3K blocks away from start block'
    )
    .option(
      '--end-block <end_block>',
      'End block number (inclusive), default to be latest block'
    ),
  ETHDump.execute,
  ['eth-node-url']
)

RainbowConfig.addOptions(
  program
    .command('near-dump <kind_of_data>')
    .option('--path <path>', 'Dir path to dump near data')
    .option(
      '--num-blocks <num_blocks>',
      'Number of blocks to dump, default: 100'
    ),
  NearDump.execute,
  ['near-node-url']
)

;(async () => {
  await program.parseAsync(process.argv)
})()
