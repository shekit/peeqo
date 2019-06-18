const event = require('js/events/events');
const common = require('js/helpers/common');
const media = require('js/helpers/media');
const responses = require('js/responses/responses');

const ACTION_HISTORY_LIMIT = 5;

class PeeqoAction {
    constructor(data) {
		this.data = data;
    }

    /**
	 * Perform this action
     * @param overrides Any attributes for the actions's data that should be overridden via the method call
     * @returns {Promise<void>}
     */
    async perform(overrides={}) {
    	console.log('Performing action ', this.data.name);

        // merge overridden values and new values
        Object.assign(this.data, overrides);


        if(this.data.hasOwnProperty('sound') && this.data.sound !== null) {
            if(this.data.hasOwnProperty('volume') && this.data.volume != null) {
                event.emit('play-sound', this.data.sound, this.data.volume);
            }
            else {
                event.emit('play-sound', this.data.sound, 0.5)
            }
        }

        let q = await common.setQuery(this.data);
        console.log(`LOCAL FILE OR SEARCH QUERY > ${q}`);

        let r = null;

        if(this.data.type === 'remote'){
            r = await media.findRemoteGif(q);
            console.log(`MEDIA URL > ${r}`);
        } else {
            // local response
            r = q
        }

        let mediaType = await media.findMediaType(r);
        let d = await media.findMediaDuration(r);

        console.log(`MEDIA DURATION > ${d}`);

        if(this.data.hasOwnProperty('led') && Object.keys(this.data.led).length !== 0) {
            // run led animation
            event.emit('led-on', {anim: this.data.led.anim , color: this.data.led.color });
        }

        if(this.data.hasOwnProperty('servo') && this.data.servo !== null) {
            // move servo
            event.emit('servo-move', this.data.servo);
        }

        if(this.data.hasOwnProperty('cbBefore')) {
            this.data.cbBefore();
        }

        let showMedia = common.transitionToMedia(d, mediaType);

        if(this.data.hasOwnProperty('text') && this.data.text) {
            text.showText(this.data.text);
        }

        if(this.data.hasOwnProperty('cbDuring')) {
            this.data.cbDuring();
        }

        let o = await common.transitionFromMedia(d);

        if(this.data.hasOwnProperty('text')) {
            text.removeText();
        }

        console.log(`RESPONSE > END`);

        // callback
        if(this.data.hasOwnProperty('cbAfter')) {
            this.data.cbAfter();
        }
    }
}

class PeeqoActor {
	constructor() {
		this.actionHistory = [];
	}

    performAction(action, overrides={}) {
        this.actionHistory.push(action);
        if(this.actionHistory.length > ACTION_HISTORY_LIMIT) {
            this.actionHistory.pop();
        }

        action.perform(overrides);
    }

    wakeword() {
        this.performAction(new PeeqoAction(responses.wakeword, {type:'wakeword'}));
    }
}


module.exports = {
	PeeqoAction : PeeqoAction,
	PeeqoActor : PeeqoActor
}