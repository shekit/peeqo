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

            case "greeting":
                this.actor.performAction(new PeeqoAction(responses.greeting, {type: 'remote'}));
                break;

            case "camera":
                event.emit(`camera-${cmd.params.on.stringValue}`);
                break;

            case "timer":
                let timer = new Timer(cmd.params.time.numberValue, cmd.params.timeUnit.stringValue);
                timer.startTimer();
                break;

            case "weather":
                let weather = new PeeqoWeather(this.actor);
                weather.getWeather(cmd.params.city.stringValue);
                break;

            case "changeGlasses":
                event.emit("change-glasses");
                break;

            case "goodbye":
                this.actor.performAction(new PeeqoAction(responses.bye, {type: 'local'}));
                break;

            case "cat":
                let callbackDuringResponse = () => {
                    speak.speak(`${cmd.responseText}`);
                    console.log(`responseText: ${cmd.responseText}`)
                };

                this.actor.performAction(new PeeqoAction(responses.cat, {type: 'remote', cbDuring: callbackDuringResponse}));
                break;

            case "hue":
                let hue = new PeeqoHue(this.actor);
                hue.discoverNearbyBridges();
                hue.changeGroupState(cmd.params.hue_group.stringValue, {on: cmd.params.hue_state.stringValue === "on"});
                break;

            case "Patrick":
                this.actor.performAction(new PeeqoAction(responses.patrick, {type: 'local'}));
                break;

            default:
                this.actor.performAction(new PeeqoAction(responses.confused, {type:'local'}));
                break
        }

        // setAnswer(responses[cmd.intent], {type:'remote'})
    }
}


module.exports = SnipsIntentEngine;