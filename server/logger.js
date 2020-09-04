const log4js = require('log4js')
const config = require('./config')
log4js.configure(config.log);

module.exports = {
    getLogger: (category) => {
        return log4js.getLogger(category)
    },
    getExpressLogger: () => {
        return log4js.connectLogger(log4js.getLogger('access'), {
            level: log4js.levels.INFO
        })
    }
}