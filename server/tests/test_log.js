const log4js = require('log4js')
const config = require('../config')

log4js.configure(config.log);

const logger = log4js.getLogger('access')

logger.info('output hello world')