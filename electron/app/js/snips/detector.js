'use strict'

const mqtt = require('mqtt');
const event = require('js/events/events')


class SnipsDetector {
    constructor() {
        this.hostname = "mqtt://localhost";
    }

    start() {
        this.client = mqtt.connect(this.hostname);
        this.client.on('connect', this.onConnect);

        var self = this;
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
        console.log("[Snips Log] Connected to MQTT broker " + this.hostname);
        this.client.subscribe('hermes/#');
    }

    onIntentDetected(intent) {
        console.log("[Snips Log] Intent detected: " + JSON.stringify(intent));
    }

    onHotwordDetected() {
        console.log("[Snips Log] Hotword detected");
        event.emit("wakeword");
    }

    onListeningStateChanged(listening) {
        console.log("[Snips Log] " + (listening ? "Start" : "Stop") + " listening");
    }
}

module.exports = SnipsDetector