const event = require('js/events/events')
const action = require('js/actions/actions')
const common = require('js/helpers/common')

module.exports = () => {

	event.on('wakeword', action.hotword)

	// passes on response object from speech to text engine
	event.on('final-command', action.parseIntent)

	// passes id of div to show
	event.on('show-div', common.showDiv)

}