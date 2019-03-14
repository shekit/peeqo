const events = require('events')
const eventEmitter = new events.EventEmitter()

eventEmitter.setMaxListeners(Infinity)

module.exports = eventEmitter