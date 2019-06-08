const event = require('js/events/events')

class Text{
	constructor(){
		this.text = document.getElementById("textOverlay")

		event.on('show-text', this.showText)
		event.on('remove-text', this.removeText)
	}

	showText(content){
		this.text.innerHTML = content
	}

	removeText(){
		this.text.innerHTML = ''
	}
}

// make singleton
const text = new Text()
Object.freeze(text)

module.exports = text