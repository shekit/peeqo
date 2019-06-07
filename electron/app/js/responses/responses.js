module.exports = {

	/*
	Obj Structure:

	intentName: {
		localFolder: 'xxx' <- Local folder in app/media/responses/ where you are storing local media responses
		queryTerms: ['a','b','c'] <- what terms to use to query media from sources like giphy.com
		servo: 'ccc' <- name of servo animation stored in app/media/servo_anims/ (without the .json)
		led: {
			anim: 'eee' <- name of animation, must be a function in app/js/senses/leds.js 
			color: 'red' <- color leds, must be defined in app/js/senses/leds.js
		}
		sound: 'cccc.wav/mp3' <- mp3 or wav file located in app/media/sounds/
		cb: function <- callback function to be called at end of response
	}
	*/

	
	confused: {
		localFolder: 'confused',
		queryTerms: ['shrug', 'confused', 'dont know'],
		servo: null,
		led: {
			anim: 'blink',
			color: 'orange'
		},
		sound: null
	},

	greeting: {
		localFolder: 'greeting',
		queryTerms: ['hello','hi','howdy','sup','whatsup'],
		servo: 'look-up-inverted',
		led: {
			anim: 'blink',
			color: 'green'
		},
		sound: null
	},

	wakeword: {
		localFolder: null,
		queryTerms: null,
		servo: 'alert',
		led: {
			anim:'circle',
			color: 'aqua'
		},
		sound: 'alert.wav',
		cb: function(){
			event.emit('speech-to-text')
		}
	}
}