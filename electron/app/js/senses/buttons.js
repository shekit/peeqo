const event = require('js/events/events')
const os = require('os')

if(os.arch() == 'arm'){
	const gpio = require('rpi-gpio')
	gpio.setMod(gpio.MODE_BCM)
	let gpios = [4,16,17,23]

	for(var i in gpios){
		gpio.setup(gpios[i], gpio.DIR_IN, gpio.EDGE_BOTH)
	}
}


function initializeButtons(){

	if(os.arch() != 'arm'){
		return
	}

	const longPressDuration = 3000

	gpio.on('change', (channel, value) => {

		let btnTimer = null
		let longPressEventSent = false
		let pressed = false

		
		if(value === false){
			console.log(`Btn ${channel} momentary press`)
			clearTimeout(btnTimer)
			btnTimer = null
			pressed = false

			if(!longPressEventSent){
				event.emit(`btn-${channel}-short-press`)
			}
			
		} else if(value === true){
			if(!pressed){
				btnTimer = setTimeout(()=>{
					event.emit(`btn-${channel}-long-press`)
					longPressEventSent = true
					btnTimer = null
				}, longPressDuration)
			}

			pressed = true
			
		}
	})
}

module.exports = {
	initializeButtons
}