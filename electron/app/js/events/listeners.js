const event = require('js/events/events')
const action = require('js/actions/actions')
const common = require('js/helpers/common')
const power = require('js/power/power')
const speak = require('js/senses/speak')

module.exports = () => {

	event.on('wakeword', action.hotword)

	// passes on response object from speech to text engine
	event.on('final-command', action.parseIntent)

	event.on('no-command', () => {
		console.log("nothing heard")
	})

	// passes id of div to show
	event.on('show-div', common.showDiv)

	event.on('shutdown', power.shutdown)

	event.on('reboot', power.reboot)

	event.on('play-sound', speak.playSound)

}