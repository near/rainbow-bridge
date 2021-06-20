# New BSC Feature

The new BSC feature allows to connect and validate Binance Smart Chain blocks.

# Technical

When the Bridge is configured to use **bsc** mode, the first header have to be an Epoch header (block_number%200==0), the reason is that the epoch header contains the validator set inside the extra_data, which are used to validate the header coinbase, then it starts to receive and validate the other blocks.
Then each time the near client get a new epoch header it update the epoch_header to the new one.


# New Configurations:

The Bridge handle POW(ethash), POSA(bsc) or POA, by default the POW is used.

To use `bsc`:
```json
    nearClientValidateHeader: 'true',
    nearClientValidateHeaderMode: 'bsc'
```

and to use `ethash`:
```json
    nearClientValidateHeader: 'true',
    nearClientValidateHeaderMode: 'ethash'
```

here is an example of the new config file `~/.rainbow/config.json`:
```json
    {
        "nearNodeUrl": "http://localhost:3030",
        "nearNetworkId": "local",
        "nearMasterAccount": "node0",
        "nearMasterSk": "ed25519:3D4YudUQRE39Lc4JHghuB5WM8kbgDDa34mnrEP5DdTApVH81af7e2dWgNPEaiQfdJnZq1CNPp5im4Rg5b733oiMP",
        "ethNodeUrl": "https://data-seed-prebsc-1-s1.binance.org:8545",
        "ethMasterSk": "0x2bdd21761a483f71054e14f5b827213567971c676928d9a1808cbfa4b7501200",
        "nearClientValidateHeader": "true", 
        "nearClientValidateHeaderMode": "bsc",
        "nearClientSk": "ed25519:3D4YudUQRE39Lc4JHghuB5WM8kbgDDa34mnrEP5DdTApVH81af7e2dWgNPEaiQfdJnZq1CNPp5im4Rg5b733oiMP",
        "nearProverSk": "ed25519:3D4YudUQRE39Lc4JHghuB5WM8kbgDDa34mnrEP5DdTApVH81af7e2dWgNPEaiQfdJnZq1CNPp5im4Rg5b733oiMP",
        "ethEd25519Address": "0x62ff99964d1026bfd3fea2086b9d141917f1a793",
        "ethClientLockEthAmount": "1000",
        "ethClientLockDuration": "10",
        "ethClientAddress": "0x2cdaaa435937ae65705b97fbd01d28f4f6494545",
        "ethProverAddress": "0x5cdc96ce31bdf08ef39d5f65a9fd5e236ce2245f",
        "ethErc20Address": "0x7ef88a3901494435700ccc4c7615903b43ec2dbc",
        "ethLockerAddress": "0x24d718f7d8af7d7a4abaa2b1cb7abbb36a23a00d",
        "ethAdminAddress": "0xDf08F82De32B8d460adbE8D72043E3a7e25A3B39"
    }
```

# Deploy the bridge locally with BSC Mode

To run the bridge locally with Binance Smart Chain, run the following cmd: 

1. init yarn and generate ethereum contracts: 

```bash
make init
```

2. start near blockchain and connect with binance test net.
```bash
make start-bsc
```

3. Deploy the near and ethereum contracts

```bash
make full-bsc-contracts
```
or use already deployed contracts (on BSC), first copy past the following parameters inside the `~/.rainbow/config.json` file: 

```bash
    "ethEd25519Address": "0x62ff99964d1026bfd3fea2086b9d141917f1a793",
    "ethClientLockEthAmount": "1000",
    "ethClientLockDuration": "10",
    "ethClientAddress": "0x2cdaaa435937ae65705b97fbd01d28f4f6494545",
    "ethProverAddress": "0x5cdc96ce31bdf08ef39d5f65a9fd5e236ce2245f",
    "ethErc20Address": "0x7ef88a3901494435700ccc4c7615903b43ec2dbc",
    "ethLockerAddress": "0x24d718f7d8af7d7a4abaa2b1cb7abbb36a23a00d",
    "ethAdminAddress": "0xDf08F82De32B8d460adbE8D72043E3a7e25A3B39"
```
then run the following command:

```bash
make light-bsc-contracts
```

4. Start the relayers:

```bash
make start-relayer
```

5. When you are done you can stop the brisge by running:

```bash
make stop-all
```

- The brisge use pm2 tool so you can use it to check logs and list the processes
- If you need BNB you can request some using [Binance faucet](https://testnet.binance.org/faucet-smart) using the following Address: `0xDf08F82De32B8d460adbE8D72043E3a7e25A3B39`
