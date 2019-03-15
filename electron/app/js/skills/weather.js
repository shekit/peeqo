const config = require('config/config')

function getWeather(city){

	// @param {string} city - city to find weather of

	if(!city){
		// enter your default city here
		city = config.openweather.city
	}

	let query = encodeURI(city)

	fetch(`http://api.openweathermap.org/data/2.5/weather?q=${query}&units=imperial&APPID=${config.openweather.key}`)
		.then((response)=> response.json())
		.then((json)=>{
			console.log(json)
			if(json.cod == '404'){
				console.error(`Cant find city ${query}`)
				return
			}
			console.log(`The temperature in ${json.name} is ${json.main.temp} degrees with ${json.weather[0].description}`)
		})
}

module.exports = {
	getWeather
}