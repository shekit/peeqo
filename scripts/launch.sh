#!/bin/bash

# starts bg script to access camera
cd ~/peeqo/python
python zero.py &


cd ~/peeqo/electron
export DISPLAY=:0
./node_modules/.bin/electron main.js