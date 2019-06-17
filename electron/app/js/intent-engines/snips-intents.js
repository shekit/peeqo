const actions = require('js/actions/actions')
const weather = require('js/skills/weather')
const PeeqoHue = require('js/skills/hue')
const Timer = require('js/skills/timer')
const event = require('js/events/events')
const responses = require('js/responses/responses')
const IntentEngine = require('js/intent-engines/base-intents');

// TODO: Make a base class to handle a lot of this stuff
class SnipsIntentEngine extends IntentEngine {
    constructor() {
        super();
    }

    interceptEvents() {
        var self = this;
        event.on('snips-onConnect', function(){
            event.emit('onConnect');
        });

        event.on('snips-finalCommand', self.parseIntent);

        event.on('snips-wakeword', function(){
            event.emit('wakeword');
        });

        event.on('snips-listening', function(listening) {
            event.emit('listening', listening);
        });
    }

    parseIntent(cmd) {

        /* param {cmd} - response object from speech to text engine */

        console.log('cmd');
        console.log(cmd);

        var intentName = "";

        if(cmd.intent != null && cmd.intent.intentName != null) {
            var intentSplit = cmd.intent.intentName.split(':');
            if(intentSplit.length === 2) {
                intentName = intentSplit[1];
            }
        }

        switch(intentName) {

            case "greeting":
                actions.setAnswer(responses.greeting, {type: 'remote'})
                break

            case "camera":
                event.emit(`camera-${cmd.params.on.stringValue}`)
                break

            case "timer":
                let timer = new Timer(cmd.params.time.numberValue, cmd.params.timeUnit.stringValue)
                timer.startTimer()
                break

            case "weather":
                weather.getWeather(cmd.params.city.stringValue)
                break

            case "changeGlasses":
                event.emit("change-glasses")
                break

            case "goodbye":
                actions.setAnswer(responses.bye, {type: 'local'})
                break

            case "cat":
                let callbackDuringResponse = () => {
                    speak.speak(`${cmd.responseText}`)
                    console.log(`responseText: ${cmd.responseText}`)
                }

                actions.setAnswer(responses.cat, {type: 'remote', cbDuring: callbackDuringResponse})
                break

            case "hue":
                let hue = new PeeqoHue()
                hue.discoverNearbyBridges()
                hue.changeGroupState(cmd.params.hue_group.stringValue, {on: cmd.params.hue_state.stringValue === "on"})
                break

            case "Patrick":
                actions.setAnswer(responses.patrick, {type: 'local'});
                break;

            default:
                actions.setAnswer(responses.confused, {type:'local'})
                break
        }

        // setAnswer(responses[cmd.intent], {type:'remote'})
    }
}


module.exports = SnipsIntentEngine;