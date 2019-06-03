#!/bin/bash

cd ~/peeqo-v2-tests/python-cam-test
python zero.py &

cd ~/peeqo-v2-tests
./node_modules/.bin/electron main.js