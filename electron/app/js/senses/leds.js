const dotstar = require('js/lib/dotstar')
const os = require('os')
const event = require('js/events/events')

let SPI = null
let spi = null

if(os.arch == "arm"){
	SPI = require('pi-spi')
	spi = SPI.initialize('/dev/spidev0.0')
}

class Leds {

	constructor() {

		this.brightness = 0.5
		this.length = 12
		this.colors = {
			"red":[255,0,0],
			"green":[0,255,0],
			"blue":[0,0,255],
			"aqua":[0,255,255],
			"purple":[190,64,242],
			"orange":[239,75,36],
			"yellow":[255,215,18],
			"pink":[244,52,239],
			"black":[0,0,0]
		}
		this.currentlyOn = []
		this.trailLength = 3

		this.strip = null

		if(os.arch == "arm" && spi != null){
			// only available on pi
			this.strip = new dotstar.Dotstar(spi, {
				length: this.length
			})
		}

		this.playAnimation = this.playAnimation.bind(this)
		this.off = this.off.bind(this)

		if(this.strip){
			// only listen for led events on pi
			event.on('led-on', this.playAnimation)
			event.on('led-off', this.off)
		}
	}

	playAnimation(anim){
		// @param {obj} anim - contains keys for anim type and color
		this[anim.anim](anim.color)
	}

	blink(color='red', time=500, count=5, brightness=0.5) {
		let blinkCount = 0

		let blinkInterval = setInterval(() => {
			if(blinkCount%2==0){
				this.on(color, brightness)
			} else {
				this.off()
			}

			blinkCount++

			if(blinkCount>count){
				clearInterval(blinkInterval)
				blinkInterval = null
			}
		}, time)
	}

	fade (){

	}

	circle(color="aqua"){
		this.trail(0,5)
		this.trail(11,6)

		setTimeout(() => {
			this.trail(color, 5,0,false)
			this.trail(color,6,11,false)
		}, 1000)

		setTimeout(()=>{
			this.off()
		}, 2500)
	}

	circleOut(color="green"){
		this.trail(color, 0, 5)
		this.trail(color, 11,6)
	}

	trail(color, start, finish, overshoot=true, brightness=0.5, time=100, trailLength=3){

		if((start < 0 || finish < 0) || (start > this.length || finish > this.length)){
			console.error(`Led values are outside permissible range of 0-11`)
			return
		}

		let firstLed = start
		let currentlyOn = []

		let moveInterval = setInterval(() => {
			currentlyOn.push(firstLed)

			if(currentlyOn.length > trailLength){
				// remove first led to maintain trail length
				let removeLed = currentlyOn.shift()
				this.strip.set(removeLed, ...this.colors["black"],0)
			}

			for(let i=0;i<currentlyOn.length;i++){
				this.strip.set(currentlyOn[i],...this.colors[color], brightness)
			}

			this.strip.sync()

			console.log(currentlyOn)

			if(start < finish){
				// move in clockwise direction
				firstLed++

				if(firstLed > finish){
					clearInterval(moveInterval)
					moveInterval = null
					if(overshoot){
						this.clearLedTrail(currentlyOn, time)
					}
				}
			} else if (start > finish){
				// move in anticlockwise direction
				firstLed--

				if(firstLed < finish){
					clearInterval(moveInterval)
					moveInterval = null
					if(overshoot){
						this.clearLedTrail(currentlyOn, time)
					}
				}
			}
		}, time)
	}

	clearLedTrail(onLeds, time=100){
		let removeInterval = setInterval(() => {
			if(onLeds.length != 0){
				let offLed = onLeds.shift()
				this.strip.set(offLed, ...this.colors["black"],0)
			} else {
				clearInterval(removeInterval)
				removeInterval = null
				this.strip.clear()
			}

			this.strip.sync()
		}, time)
	}

	on(color, brightness=0.5){
		if(!this.colors.hasOwnProperty(color)){
			console.error(`Color ${color} has not been set`)
			return
		}

		this.strip.all(...colors[color], brightness)
		this.strip.sync()
	}

	off(){
		this.strip.clear()
		this.strip.sync()
	}
}

// make singleton
const leds = new Leds()
Object.freeze(leds)

module.exports = leds