'use strict'

require('app-module-path').addPath(__dirname);

// Dependencies
const event = require('js/events/events');
const mic = require('js/senses/mic');
const Eyes = require('js/face/eyes');
const Glasses = require('js/face/glasses');
const speak = require('js/senses/speak');
const buttons = require('js/senses/buttons');
const weather = require('js/skills/weather');
const PeeqoListener = require('js/events/listeners');
const Actions = require('js/actions/actions');

// Snip-dependencies (need to abstract out further, probably, into a configuration thing)
const SnipsDetector = require('js/snips/detector');
const SnipsIntentsEngine = require('js/intent-engines/snips-intents');


// 'global' variables
const peeqoListener = new PeeqoListener();
var detector = null;
const peeqoActor = new PeeqoActor();

// Start the intent engine
peeqoListener.setIntentEngine(new SnipsIntentsEngine(peeqoActor));

// Only include the detector for environments it is supported on
if(process.env.OS !== 'unsupported') {
	detector = new SnipsDetector();
}


// keyboard shortcuts
const remote = require('electron').remote

document.addEventListener("keydown", (e)=>{
	if(e.which === 123){

		// F12 - show js console
		remote.getCurrentWindow().toggleDevTools()
	}
	else if(e.which === 116){

		// F5 - refresh page
		// make sure page is in focus, not console
		location.reload()
	}
});


// initiate eyes and glasses
const eyes = new Eyes()
event.emit('show-div', 'eyeWrapper');
event.emit('start-blinking');
const glasses = new Glasses();


// Wait for initialization? This should probably be done via an async stream instead
setTimeout(()=>{
}, 3000);


// initiate buttons
buttons.initializeButtons();

//initiate leds and run initial animation
const leds = require('js/senses/leds');
event.emit('led-on', {anim: 'circle', color: 'aqua'});

// initiate camera
const Camera = require('js/senses/camera');
const camera = new Camera();

// initiate servos
const Servo = require('js/senses/servo');
const servo = new Servo();

// initiate text
const text = require('js/senses/text');

// set audio volume level. 0 - mute; 1-max
event.emit('set-volume', 0.4);

// initiate listening or show wakeword button
if(process.env.OS === 'unsupported') {
	// on certain linux systems and windows snowboy offline keyword detection does not work
	// pass in OS=unsupported when starting application to show a clickable wakeword button instead
	document.getElementById("wakeword").addEventListener('click', (e) => {
		e.preventDefault();
		document.getElementById("wakeword").style.backgroundColor = "red"
		event.emit('wakeword')
	});
}
else {
	if(detector != null) {
		detector.start();
	}

	document.getElementById("wakeword").style.display = "none"
}
