const path = require('path')
const fs = require('fs')
const os = require('os')
const event = require('js/events/events')

let i2cBus = null
let PCA9685 = null
let options = null

if(os.arch() == 'arm'){
	//only setup on pi

	i2cBus = require('i2c-bus')

	PCA9685 = require('pca9685').Pca9685Driver

	options = {
		i2c: i2cBus.openSync(1),
		address: 0x40,
		frequency: 50,
		debug: false
	}
}

class Servo {

	constructor(){
		this.pwm = null
		this.servoTimer = null
		this.playbackRate = 33 //ms
		this.servoRestAngle = 1500

		this.animate = this.animate.bind(this)
		this.reset = this.animate.bind(this)

		if(PCA9685 != null){
			this.pwm = new PCA9685(options, (err) => {
				if(err) console.error(`Error initializing PCA9685 for servos`);

				for(var i=0;i<3;i++){
					this.pwm.setPulseLength(i, this.servoRestAngle)
				}
			})

			event.on('servo-move', this.animate)
			event.on('servo-reset', this.reset)
		}
		
	}

	animate(animName){

		console.log(`SERVO > ${animName}.json`)
		
		let filepath = path.join(process.cwd(),'app','media','servo_anims',`${animName}.json`)

		fs.readFile(filepath, 'utf8', (err, contents) => {
			if(err){
				console.error(`Error reading animation file`)
				console.log(err)
				return
			}

			try {
				const data = JSON.parse(contents)
				servoPlayback(animData)

			} catch(error){
				console.error(`Error playing servo from anim file`)
				console.error(error)
			}
		})
	}

	reset(){
		if(this.servoTimer != null){
			clearInterval(this.servoTimer)
			this.servoTimer=null
		}
		for(let i=0;i<3;i++){
			this.pwm.setPulseLength(i, this.servoRestAngle)
		}
	}

	servoPlayback(animData){
		let index = 0

		this.servoTimer = setInterval(() => {
			for(var i=0;i<3;i++){
				this.pwm.setPulseLength(i, animData[index][i])
			}

			index ++

			if(index >= animData.length){
				console.log(`Finished playing servo animation`)
				clearInterval(this.servoTimer)
				this.servoTimer = null
				this.reset()
			}
		}, this.playbackRate)
	}
}

//make singleton
const servo = new Servo()
Object.freeze(servo)

module.exports = servo