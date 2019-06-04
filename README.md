# Get a Peeqo Dev Kit
Get on the waitlist for a peeqo dev kit? Enter your email here - http://bit.ly/2TyocgY

# Getting your Peeqo up and running

0. [Unboxing](#step-0-unboxing)
1. [Setup SD Card](#step-1-setup-sd-card)
2. [Assemble Peeqo](#step-2-assemble-peeqo)

## Step 0: Unboxing

## Step 1: Setup SD Card

## Step 2: Assemble Peeqo

# Setup Instructions

## Getting Started:
1. [Setup Wakeword](#setup-wakeword)
2. [Setup Dialogflow](#setup-dialogflow)
3. [Rename `config-dev.js` to `config.js`](#rename-config-file)
4. [Setup on Mac OSX/Linux](#setup-on-system)
5. [Additional Steps](#additional-steps)

### Setup Wakeword

Peeqo uses snowboy for offline on-device wakeword detection. Follow these steps to get him to respond to you saying Peeqo.

1. Go to <a href="https://snowboy.kitt.ai/dashboard" target="_blank">https://snowboy.kitt.ai/dashboard</a>
2. Login using Google/Github/Facebook
3. Type “Peeqo” in the “Search Hotwords” text box & hit enter. Only one result should turn up
4. Click on the microphone icon near the Peeqo search result
5. Click “Record my voice” in the popup that opens
6. Follow the instructions and record yourself saying Peeqo three times. You will need to allow the browser microphone access
7. Click on “Test the model”
8. Enter the details on the left and say “Peeqo” a couple of times till it says “Test Successful”
9. The model is now trained to respond to only you saying Peeqo
10. Click on “Save and download”. 
11. This will create a file called `Peeqo.pmdl`.
12. Place this file in `/electron/app/config/`

### Setup Dialogflow

Peeqo uses Google's dialogflow for Speech-to-text. You can replace this with another service of your choice later. 

1. Go to <a href="http://dialogflow.com" target="_blank">dialogflow.com</a>
2. Click on “Go to console” in top right and login using your google id
3. Grant permissions, select Country and accept terms & conditions
4. Click “Create Agent”
5. Enter “Peeqo” in agent name and click “Create”. Change language and time zone if required. Make sure to leave the default option of “Create a new Google project” selected
6. Once created, click on the cog icon near the agent name in the left hand menu to open agent settings
7. Click on Export and Import > Import from Zip
8. Drag and drop `/electron/app/config/dialogflow-agent.zip` from this repo. Type IMPORT in the text box and click Import to upload this agent
9. In the General settings of your agent, make a note of the “Project ID”. Enter this in `/app/config/config-dev.js` -> `speech.projectId`
10. Click on the link labeled Service Account. This will take you to your google cloud console page
11. In the cloud console page, click on the three vertical dots in the Action column of this Service Account and select “Create Key”
12. Make sure JSON is selected and click create.
13. This will download a JSON file to your computer. Keep it safe and never share it.
14. Place this file in `/electron/app/config/`
15. Enter the full name of this file in `/electron/app/config/config-dev.js` -> `speech.dialogflowKey`. You can rename the file if needed to make it simpler.
16. This agent should give you a good starting of some existing responses. You can now add your own responses and intents to it on dialogflow to add functionality. Go to <a href="https://dialogflow.com/docs/getting-started" target="_blank">https://dialogflow.com/docs/getting-started</a> to learn more.

### Rename config file

After following the two steps above and entering the necessary keys and filepaths, rename `config-dev.js` to `config.js`

### Setup on System

You can currently run the app on Mac OSX or Ubuntu14.04 for development purposes. You can develop on your system and then push it to your Peeqo's raspberry pi. On other systems, if wakeword detection is unsupported, I have added a small button on the top left corner to simulate a wakeword. 

#### Setup on Mac OSX:

* **Install node version**
  * Select the installer for your OS from this link - <a href="https://nodejs.org/en/blog/release/v8.15.1/" target="_blank">https://nodejs.org/en/blog/release/v8.15.1/</a>
  * Check node and npm version
    * `node -v // 8.15.1`
    * `npm -v // 6.4.1`
    * You can also use nvm to install node 8.15.1 if you already have another node version installed - https://github.com/creationix/nvm
* **Install snowboy dependencies on Mac** (<a href="https://github.com/Kitt-AI/snowboy" target="_blank">https://github.com/Kitt-AI/snowboy</a>)
  * `brew install swig portaudio sox`
  * `pip install pyaudio`
  * If you don't have Homebrew installed, please download it <a href="https://brew.sh/">here</a>. If you don't have pip, you can install it <a href="https://pip.pypa.io/en/stable/installing/">here</a>.
* **Install snowboy dependencies on Linux**
  * `sudo apt-get install swig3.0 python-pyaudio python3-pyaudio sox`
  * `pip install pyaudio`
  * `sudo apt-get install libmagic-dev libatlas-base-dev`
* **Clone github repo:**
  * `git clone https://github.com/shekit/peeqo.git`
* **CD into github folder:**
  * `cd /path/to/repo/electron`
* **Install packages:**
  * `npm install`
  * `./node_modules/.bin/electron-rebuild --pre-gyp-fix`
* **Run app in Debug Mode:**
  * This will open the chrome inspector panel. Run from electron folder
  * `NODE_ENV=debug npm start`
* **Run app in Production Mode:**
  * This will not open chrome inspector panel. Run from electron folder
  * `npm start`
  
#### Setup on Ubuntu 14.04:
* **Install node version (8.15.1)**
  * `curl -sL https://deb.nodesource.com/setup_8.x | sudo -E bash -`
  * `sudo apt-get install -y nodejs`
  * Check node and npm version
    * `node -v // 8.15.1`
    * `npm -v // 6.4.1 or higher`
    * You can also use nvm to install node 8.15.1 if you already have another node version installed - https://github.com/creationix/nvm
* **Install git & pip:**
  * `sudo apt-get install git python-pip -y`
* **Install snowboy dependencies:**
  * `sudo apt-get install swig3.0 python-pyaudio python3-pyaudio sox`
  * `pip install pyaudio`
  * `sudo apt-get install libmagic-dev libatlas-base-dev`
* **Clone github repo:**
  * `git clone https://github.com/shekit/peeqo.git`
* **CD into github folder:**
  * `cd /path/to/repo/electron`
* **Install packages:**
  * `npm install`
  * `./node_modules/.bin/electron-rebuild --pre-gyp-fix`
* **Run app in Debug Mode:**
  * This will open the chrome inspector panel. Run from electron folder
  * `NODE_ENV=debug npm start`
* **Run app in Production Mode:**
  * This will not open chrome inspector panel. Run from electron folder
  * npm start


#### Setup on Unsupported OS (Ubuntu 18.04, Debian, Linux distros):

* Follow all steps for Ubuntu 14.04 except Step 3 to install Snowboy
* `sudo apt install libgconf2-4`
* Run app with correct flag:
  * `NODE_ENV=debug OS=unsupported npm start`
  * This will show a hotword button in top left corner of the screen. Click this button and speak your command to simulate wakeword detection





### Additional Steps

You can setup these additional services as well. These are optional for initial setup. This list will keep growing. Feel free to add your own.

#### Creating your own Wakeword:
1. Repeat all the steps in Setup Wakeword, except for Step 3 & Step 4.
2. Instead click on the “Create Hotword” button and record your own custom wakeword
3. Remember to change the wakeword key in `/app/config/config-dev.js` to match your custom wakeword
4. P.S If using your own custom keyword, please follow the above steps and record for Peeqo as well so we can have a general model which needs 500 samples from different people.


#### Vlipsy Api - For Video responses:
1. For video responses, Peeqo uses vlipsy.com
2. Vlipsy has no public api key. You can request one by emailing api@vlipsy.com. You can mention you need it for Peeqo.
3. Enter this key in `/app/config/config.js` -> `vlipsy.key`

#### Giphy Api - For GIF responses:
1. For gif responses, Peeqo uses giphy.com. Giphy has a public api key included in the app which is ready to use.
2. You can get your own private api key by visiting <a href="https://developers.giphy.com/docs/" target="_blank">https://developers.giphy.com/docs/</a> and requesting for one for free

#### Setup Weather Api:
1. Peeqo uses openweather api for weather updates
2. You can get a free api key by going to <a href="https://openweathermap.org/api" targt="_blank">https://openweathermap.org/api</a>
3. Enter this key `app/config/config-dev.js` -> `openweather.key`

#### Spotify Api - For music playback:
1. You will need a client_id & client_secret to access spotify
2. Go to <a href="https://developer.spotify.com/dashboard/applications" target="_blank">https://developer.spotify.com/dashboard/applications</a>
3. Sign in with your Spotify account
4. Create a new app by clicking “My New App”
5. Go through the steps to get a client_id & client_secret
6. Copy and paste these in `app/js/config/config-dev.js` under `spotify.clientId`, `spotify.clientSecret`
7. Note: for non-premium users, I think spotify only provides 30 sec samples through the api




