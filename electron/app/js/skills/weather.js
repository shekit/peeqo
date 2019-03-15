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
			
			displayWeather(json)
		})
}

function displayWeather(data){
	console.log(`The temperature in ${data.name} is ${data.main.temp} degrees with ${data.weather[0].description}`)
}

module.exports = {
	getWeather
}