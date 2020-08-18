const ProcessManager = require('pm2')
const { spawnProcess } = require('./helpers')
const { Near2EthWatchdog } = require('../../lib/near2eth-watchdog')
const { RainbowConfig } = require('../../lib/config')

class StartNear2EthWatchdogCommand {
  static async execute() {
    if (RainbowConfig.getParam('daemon') === 'true') {
      ProcessManager.connect(err => {
        if (err) {
          console.log(
            'Unable to connect to the ProcessManager daemon! Please retry.'
          )
          return
        }
        spawnProcess('near2eth-watchdog', {
          name: 'near2eth-watchdog',
          script: 'index.js',
          interpreter: 'node',
          error_file: '~/.rainbow/logs/near2eth-watchdog/err.log',
          out_file: '~/.rainbow/logs/near2eth-watchdog/out.log',
          args: [
            'start',
            'near2eth-watchdog',
            ...RainbowConfig.getArgsNoDaemon(),
          ],
          logDateFormat: 'YYYY-MM-DD HH:mm:ss.SSS',
        })
      })
    } else {
      const watchdog = new Near2EthWatchdog()
      await watchdog.initialize()
      await watchdog.run()
    }
  }
}

exports.StartNear2EthWatchdogCommand = StartNear2EthWatchdogCommand
