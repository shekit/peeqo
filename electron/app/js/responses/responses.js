module.exports = {

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