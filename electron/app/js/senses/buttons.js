const event = require('js/events/events')
const os = require('os')

let gpio = null

if(os.arch() == 'arm'){
	// only include on raspberry pi
	gpio = require('rpi-gpio')
	gpio.setMode(gpio.MODE_BCM)
	let gpios = [4,16,17,23]

	for(var i in gpios){
		gpio.setup(gpios[i], gpio.DIR_IN, gpio.EDGE_BOTH)
	}
}


function initializeButtons(){

	if(gpio == null){
		return
	}

	const longPressDuration = 3000
	let btnTimer = null
	let longPressEventSent = false
	let pressed = false

	gpio.on('change', (channel, value) => {

		

		
		if(value == false){
			console.log(`Btn ${channel} released`)
			clearTimeout(btnTimer)
			btnTimer = null
			pressed = false

			if(!longPressEventSent){
				event.emit(`btn-${channel}-short-press`)
			}

			longPressEventSent = false
			
		} else if(value == true){
			console.log(`Btn ${channel} pressed`)
			
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