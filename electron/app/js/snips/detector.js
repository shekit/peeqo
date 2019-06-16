'use strict'

const mqtt = require('mqtt');
const event = require('js/events/events');
const config = require('config/config');

class SnipsDetector {
    constructor() {
    }

    start() {
        var self = this;
        this.client = mqtt.connect(config.snips.mqtt.hostname);
        this.client.on('connect', this.onConnect);

        this.client.on('message', function (topic, message) {
            if (topic === "hermes/asr/startListening") {
                self.onListeningStateChanged(true);
            } else if (topic === "hermes/asr/stopListening") {
                self.onListeningStateChanged(false);
            } else if (topic.match(/hermes\/hotword\/.+\/detected/g) !== null) {
                self.onHotwordDetected();
            } else if (topic.match(/hermes\/intent\/.+/g) !== null) {
                self.onIntentDetected(JSON.parse(message));
            }
        });
    }

    onConnect() {
        console.log(this);
        console.log("[Snips Log] Connected to MQTT broker " + config.snips.mqtt.hostname);
        this.subscribe('hermes/#');
        event.emit('snips-onConnect');
    }

    onIntentDetected(intent) {
        console.log("[Snips Log] Intent detected: " + JSON.stringify(intent));
        event.emit('snips-finalCommand', intent);
    }

    onHotwordDetected() {
        console.log("[Snips Log] Hotword detected");
        event.emit("snips-wakeword");
    }

    onListeningStateChanged(listening) {
        console.log("[Snips Log] " + (listening ? "Start" : "Stop") + " listening");
        event.emit('snips-listening', listening);
    }
}

module.exports = SnipsDetector