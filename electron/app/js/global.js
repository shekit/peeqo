'use strict'

require('app-module-path').addPath(__dirname)

const event = require('js/events/events')
const listen = require('js/senses/listen')
const Eyes = require('js/face/eyes')

const listeners = require('js/events/listeners')()

const eyes = new Eyes()

event.emit('show-div', 'eyeWrapper')
event.emit('start-blinking')

listen.startListening()