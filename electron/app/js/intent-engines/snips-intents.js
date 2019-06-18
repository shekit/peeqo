const { PeeqoActor, PeeqoAction } = require('js/actions/actions');
const PeeqoWeather = require('js/skills/weather');
const PeeqoHue = require('js/skills/hue');
const Timer = require('js/skills/timer');
const event = require('js/events/events');
const responses = require('js/responses/responses');
const IntentEngine = require('js/intent-engines/base-intents');
const speak = require('js/senses/speak');

class SnipsIntentEngine extends IntentEngine {
    constructor(actor) {
        super();
        this.intentDetected = false;
        this.actor = actor;
    }

    interceptEvents() {
        let self = this;+
        event.on('snips-onConnect', function() {
            event.emit('led-on', {anim: 'circle', color: 'aqua'});
            speak.speak('Snips MQTT connected!');
        });

        event.on('snips-finalCommand', function(intent) {
            self.intentDetected = true;
            self.parseIntent(intent);
        });

        event.on('snips-wakeword', function() {
            self.intentDetected = false;
            event.emit('wakeword');
        });

        event.on('snips-listening', function(listening) {
            if(!self.intentDetected) {
                if(!listening) {
                    event.emit('no-command');
                    return;
                }
            }

            event.emit('listening', listening);
        });
    }

    parseIntent(cmd) {

        /* param {cmd} - response object from speech to text engine */

        console.log('cmd');
        console.log(cmd);

        let intentName = "";

        if(cmd.intent != null && cmd.intent.intentName != null) {
            let intentSplit = cmd.intent.intentName.split(':');
            if(intentSplit.length === 2) {
                intentName = intentSplit[1];
            }
        }

        switch(intentName) {

            case "Greeting":
                this.actor.performAction(new PeeqoAction(responses.greeting, {type: 'remote'}));
                break;

            case "Camera":
                // Pull data from slots
                if (cmd.hasOwnProperty("slots") && cmd.slots != null && cmd.slots.length >= 1) {
                    let actionSlot = cmd.slots[0].value.value;
                    if(actionSlot === 'start') {
                        actionSlot = 'record';
                    }
                    event.emit(`camera-${actionSlot}`);
                }
                else {
                    this.actor.performAction(new PeeqoAction(responses.confused, {type:'local', cbDuring: function() {
                        speak.speak('Please provide an action next time.');
                    }}));
                }
                break;

            case "Timer":
                // Pull data from slots
                if (cmd.hasOwnProperty("slots") && cmd.slots != null && cmd.slots.length >= 1) {
                    let durationSlot = (cmd.slots[0].value.hours * 3600) + (cmd.slots[0].value.minutes * 60) + (cmd.slots[0].value.seconds);
                    let timer = new Timer(durationSlot, 'seconds');
                    timer.startTimer();
                    break;
                }

                this.actor.performAction(new PeeqoAction(responses.confused, {type:'local', cbDuring: function() {
                    speak.speak('Please provide a duration next time.');
                }}));
                break;

            case "Weather":
                // Pull data from slots
                if (cmd.hasOwnProperty("slots") && cmd.slots != null && cmd.slots.length >= 1) {
                    let citySlot = cmd.slots[0].value.value;

                    let weather = new PeeqoWeather(this.actor);
                    weather.getWeather(citySlot);
                }
                else {
                    this.actor.performAction(new PeeqoAction(responses.confused, {type:'local', cbDuring: function() {
                        speak.speak('Please request a city next time.');
                    }}));
                }

                break;

            case "ChangeGlasses":
                event.emit("change-glasses");
                break;

            case "Goodbye":
                this.actor.performAction(new PeeqoAction(responses.bye, {type: 'local'}));
                break;

            case "KittyTime":
                let callbackDuringResponse = () => {
                    speak.speak(`It's Kitty Time!`);
                };

                this.actor.performAction(new PeeqoAction(responses.cat, {type: 'remote', cbDuring: callbackDuringResponse}));
                break;

            case "HueGroup": {
                let hue = new PeeqoHue(this.actor);

                // Pull data from slots
                if (cmd.hasOwnProperty("slots") && cmd.slots != null && cmd.slots.length >= 2) {
                    let roomSlot = cmd.slots[0].value.value;
                    let stateSlot = cmd.slots[1].value.value;   // don't use raw here, use defined in slot instead (since casing matters)

                    hue.controlGroupLights(roomSlot, {on: stateSlot === "on"});
                }
                else {
                    this.actor.performAction(new PeeqoAction(responses.confused, {type:'local', cbDuring: function() {
                        speak.speak('Please provide the group next time.');
                    }}));
                }
                break;
            }

            case "HueLight": {
                let hue = new PeeqoHue(this.actor);

                // Pull data from slots
                if(cmd.hasOwnProperty("slots") && cmd.slots != null && cmd.slots.length >= 2) {
                    let lightSlot = cmd.slots[0].value.value;
                    let stateSlot = cmd.slots[1].value.value;   // don't use raw here, use defined in slot instead (since casing matters)

                    hue.controlLight(lightSlot, {on: stateSlot === "on"});
                }
                else {
                    this.actor.performAction(new PeeqoAction(responses.confused, {type:'local', cbDuring: function() {
                        speak.speak('Please provide the light next time.');
                    }}));
                }
                break;
            }

            case "Patrick":
                this.actor.performAction(new PeeqoAction(responses.patrick, {type: 'local'}));
                break;

            default:
                this.actor.performAction(new PeeqoAction(responses.confused, {type:'local'}));
                break
        }
    }
}


module.exports = SnipsIntentEngine;