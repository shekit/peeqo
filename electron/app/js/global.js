'use strict'

require('app-module-path').addPath(__dirname)

const event = require('js/events/events')

const listen = require('js/senses/listen')

const listeners = require('js/events/listeners')()

event.emit('show-div', 'eyeWrapper')

listen.startListening()