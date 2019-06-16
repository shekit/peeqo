const jsHue = require('js/lib/jshue')
const config = require('config/config')
const actions = require('js/actions/actions')
const speak = require('js/senses/speak')

class PeeqoHue {
    constructor() {
        this.hue = jsHue()
        this.bridge = null
        this.user = null
    }

    authenticatedRequest(req) {
        if(this.bridge == null) {
            this.bridge = this.hue.bridge(config.hue.bridgeIp)

            var username = config.hue.bridgeUser

            if(username == null) {
                this.bridge.createUser('peeqo#testdevice').then(data => {
                    console.log(data)
                    username = data[0].success.username;
                    console.log('New bridge username: ', username)
                    this.user = this.bridge.user(username)
                }).catch(e => console.error('Error creating user for Hue bridge', e))
            }
            else {
                this.user = this.bridge.user(username)
            }

            req()
        }
        else {
            speak.speak('Sorry, no Phillips Hue bridges were found matching the requested IP')
            console.error('No bridges found')
        }
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
                    // speak.speak("Phillips Huge bridge found!")
                })
            }
        }).catch(e => console.error('Error finding bridges', e))
    }

    changeGroupState(groupName, groupState) {

        console.log('changeGroupState ', groupName, ' ', groupState)

        var self = this
        this.authenticatedRequest(function(){
            self.user.getGroups().then(groups => {
                console.log(groups)
                if(Object.keys(groups).length === 0) {
                    speak.speak('Sorry, no groups were found')
                    console.error('No groups found')
                }
                else {
                    var id = 1
                    Object.keys(groups).forEach(g => {
                        var group = groups[g]
                        if(group.name === groupName) {
                            console.log('name matched')
                            self.user.setGroupState(id, groupState)
                            return
                        }
                        id++
                    })
                }

                actions.setAnswer({type:'remote', queryTerms: ['light'], text: 'Assigned group state'})
            })
        })
    }
}

module.exports = PeeqoHue