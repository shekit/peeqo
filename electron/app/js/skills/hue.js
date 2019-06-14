const jsHue = require('js/lib/jshue')
const config = require('config/config')
const actions = require('js/actions/actions')
const speak = require('js/senses/speak')

class PeeqoHue {
    constructor() {
        this.hue = jsHue()
    }

    discoverNearbyBridges() {
        this.hue.discover().then(bridges => {
            if(bridges.length === 0) {
                speak.speak('Sorry, no Phillips Hue bridges were found')
                console.error('No bridges found')
            }
            else {
                bridges.forEach(b => {
                    console.log("Bridge found at: %s", b.internalipaddress)
                    speak.speak("Phillips Huge bridge found!")
                })
            }
        }).catch(e => console.error('Error finding bridges', e))
    }

    changeGroupState(groupName, groupState) {

        var bridge = this.hue.bridge(config.hue.bridgeIp)

        if(bridge != null) {
            bridge.createUser('peeqo#connectorDevice').then(data => {
                var username = data[0].success.username;

                console.log('New bridge username: ', username)

                var user = bridge.user(username)

                user.getGroups().then(groups => {
                    if(groups.length === 0) {
                        speak.speak('Sorry, no groups were found')
                        console.error('No groups found')
                    }
                    else {
                        groups.forEach(g => {
                            console.log('group:')
                            console.log(g)
                        })
                    }

                    actions.setAnswer({type:'remote', queryTerms: ['light'], text: 'Assigned group state'})
                })
            }).catch(e => console.error('Error creating user for Hue bridge'))
        }
        else {
            speak.speak('Sorry, no Phillips Hue bridges were found matching the requested IP')
            console.error('No bridges found')
        }
    }
}

module.exports = PeeqoHue