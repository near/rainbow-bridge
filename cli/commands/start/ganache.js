const ProcessManager = require('pm2')
const { spawnProcess } = require('./helpers')
const { getScript } = require('rainbow-bridge-utils')

class StartGanacheNodeCommand {
  static async execute () {
    ProcessManager.connect((err) => {
      if (err) {
        console.log(
          'Unable to connect to the ProcessManager daemon! Please retry.'
        )
        return
      }
      spawnProcess('ganache', {
        name: 'ganache',
        script: getScript('start_ganache'),
        error_file: '~/.rainbow/logs/ganache/err.log',
        out_file: '~/.rainbow/logs/ganache/out.log',
        args: [],
        env: process.env,
        logDateFormat: 'YYYY-MM-DD HH:mm:ss.SSS'
      })
    })
    return {
      ethNodeUrl: 'ws://localhost:9545',
      ethMasterSk: '0x2bdd21761a483f71054e14f5b827213567971c676928d9a1808cbfa4b7501200',
      nearClientValidateHeader: 'false',
      nearClientValidateHeaderMode: 'ethash'
    }
  }
}

exports.StartGanacheNodeCommand = StartGanacheNodeCommand
