const event = require('js/events/events')
const execSync = require('child_process').execSync

function shutdown() {
	event.emit("reset")
	setTimeout(()=>{
		execSync('sudo shutdown -h now')
	},1000)
}

function reboot() {
	event.emit("reset")
	setTimeout(() => {
		execSync('sudo reboot -h now')
	}, 1000)
}

module.exports = {
	shutdown,
	reboot
}