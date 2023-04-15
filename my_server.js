const express = require('express');
const i2c = require('i2c-bus');
const Gpio = require('onoff').Gpio;
const cors = require('cors');
const axios = require("axios");
let motionStatus = '';
let motionLastUpdate = '';


const app = express();

app.use(cors()); // Enable CORS for all routes


//Configurations for informing on raspberry pi status
const SERVER_URL = 'https://iot-pi.herokuapp.com';
const HEARTBEAT_INTERVAL = 8000; // 8 seconds

const PORT = 3000;

// Replace with your GPIO pin numbers for the LEDs
const gpioMapping = {
    blue: new Gpio(24, 'out'),
    green: new Gpio(27, 'out'),
    yellow: new Gpio(22, 'out'),
    white: new Gpio(18, 'out'),
    red: new Gpio(23, 'out'),
};
// Motion detection LEDs
const LED5 = new Gpio(5, 'out');
const LED25 = new Gpio(25, 'out');
const LED13 = new Gpio(13, 'out');
const LED26 = new Gpio(26, 'out');
const LED16 = new Gpio(16, 'out');

//by default pir is turned off
let motionSensorEnabled = false;

// set up GPIO pin 17 as input for PIR motion sensor
const pir = new Gpio(17, 'in', 'both');

//set up settings for the flowing motion
var leds = [LED5, LED25, LED13, LED26, LED16];
var indexCount = 0; //a counter
dir = "up"; //variable for flowing direction

//variable for pi status
let lastHeartbeat = new Date().getTime();

//Configuration for the temp sensor
const busNumber = 1; // Use 1 for Raspberry Pi 3 and newer
const address = 0x38; // Sensor address

const CMD_INIT_CHECK = 0x71; // Command to check initialization
const CMD_MEASURE_TEMP_HUM = 0xAC; // Command to measure temperature and humidity

const i2c1 = i2c.openSync(busNumber);


function readTemperatureAndHumidity() {
    return new Promise((resolve, reject) => {
        const initBuffer = Buffer.from([0x00]); // Create a buffer to store the initialization check result
        i2c1.readI2cBlock(address, CMD_INIT_CHECK, 1, initBuffer, (err, bytesRead, buffer) => { // Check initialization
            if (err) {
                reject(`Error checking initialization: ${err}`);
                return;
            }
            if ((initBuffer[0] | 0x08) == 0) {
                reject('Initialization error');
                return;
            }
            const measureBuffer = Buffer.from([0x33, 0x00]); // Create a buffer to store the measurement command
            i2c1.writeI2cBlock(address, CMD_MEASURE_TEMP_HUM, 2, measureBuffer, (err) => { // Send command to measure temperature and humidity
                if (err) {
                    reject(`Error sending command to measure temperature and humidity: ${err}`);
                    return;
                }
                setTimeout(() => { // Wait for measurement to complete
                    const dataBuffer = Buffer.alloc(7); // Create a buffer to store the temperature and humidity data
                    i2c1.readI2cBlock(address, CMD_INIT_CHECK, 7, dataBuffer, (err, bytesRead, buffer) => { // Read temperature and humidity data
                        if (err) {
                            reject(`Error reading temperature and humidity data: ${err}`);
                            return;
                        }
                        const Traw = ((dataBuffer[3] & 0xf) << 16) + (dataBuffer[4] << 8) + dataBuffer[5];
                        const temperature = 200 * Traw / Math.pow(2, 20) - 50; // Calculate temperature in degrees Celsius
                        const Hraw = ((dataBuffer[3] & 0xf0) >> 4) + (dataBuffer[1] << 12) + (dataBuffer[2] << 4);
                        const humidity = 100 * Hraw / Math.pow(2, 20);
                        resolve({
                            temperature: parseFloat(temperature.toFixed(2)),
                            humidity: parseFloat(humidity.toFixed(2))
                        });
                    });
                }, 100);  // Wait 100ms for measurement to complete
            });
        });
    });
}

function flowAfterMove(fn, n, delay) {
    leds.forEach(function (currentValue) { //for each item in array
        currentValue.writeSync(0); //turn off LED
    });

    if (n <= 0) {
        return;
    }
    fn();
    setTimeout(() => {
        setImmediate(() => {
            flowAfterMove(fn, n - 1, delay);
        });
    }, delay);
}

function flowingLeds() { //function for flowing Leds
    if (indexCount == 0) dir = "up"; //set flow direction to "up" if the count >
    if (indexCount >= leds.length) dir = "down"; //set flow direction to "down">
    if (dir == "down") indexCount--; //count downwards if direction is down
    leds[indexCount].writeSync(1); //turn on LED that where array index matches>
    if (dir == "up") indexCount++ //count upwards if direction is up
};

function turnOff() { //function to run when exiting program
    leds.forEach(function (currentValue) { //for each LED
        currentValue.writeSync(0); //turn off LED
    });
};

function sendHeartbeat() {
    axios.get(`${SERVER_URL}/pi-heartbeat`)
        .then(response => {
            console.log('Heartbeat sent successfully');
        })
        .catch(error => {
            console.error(`Error sending heartbeat: ${error.message}`);
        });
}

setInterval(sendHeartbeat, HEARTBEAT_INTERVAL);

// listen for changes in PIR motion sensor state
pir.watch((err, value) => {
    if (err) {
        console.error('Error reading PIR motion sensor:', err);
        return;
    }

    if (!motionSensorEnabled) {
        return;
    }

    if (value == 1) {
        motionStatus = 'Motion detected';
        motionLastUpdate = new Date().toISOString();
        flowAfterMove(flowingLeds, leds.length * 2 + 1, 100);
        indexCount = 0;
    } else {
        motionStatus = 'No motion';
        motionLastUpdate = new Date().toISOString();
        turnOff();
    }

});

//endpoint for motion status
app.get('/motion-status', (req, res) => {
    res.json({ status: motionStatus , lastUpdate: motionLastUpdate});
});

app.use(express.static('public'));

//endpoint for finding out the environment
app.get('/environment', (req, res) => {
    const environment = process.env.NODE_ENV || 'development';
    raspberryPiServerUrl: process.env.RASPBERRY_PI_SERVER_URL || '',
    res.status(200).json({ environment });
});

//checking out whether the Raspberry Pi is sending a heartbeat
app.get('/heartbeat', (req, res) => {
    lastHeartbeat = new Date().getTime();
    res.status(200).send({ message: 'Heartbeat received' });
});

//evaluating the status Pi via the heartbeat
app.get('/pi-status', (req, res) => {
    const currentTime = new Date().getTime();
    const piOnline = currentTime - lastHeartbeat <= 10000; // 10 seconds
    res.status(200).json({ online: piOnline });
});

//endpoint for changing the state of the LED
app.get('/led/:color/:state', (req, res) => {
    const color = req.params.color;
    const led = gpioMapping[color];
    if (!led) {
        res.status(400).send('Invalid color');
        return;
    }

    const state = req.params.state === 'on' ? 1 : 0;

    led.write(state, (err) => {
        if (err) {
            res.status(500).send('Error setting LED state');
        } else {
            res.json({ success: true });
        }
    });
});

//endpoint for getting info about temp sensor
app.get('/temperature-humidity', (req, res) => {
    readTemperatureAndHumidity()
        .then(data => {
            res.json(data);
        })
        .catch(error => {
            console.error(error);
            res.status(500).send('Error reading temperature and humidity data');
        });
});

//endpoint for toggling motion sensor
app.get('/motion-sensor/toggle', (req, res) => {
    motionSensorEnabled = !motionSensorEnabled;
    res.json({ motionSensorEnabled: motionSensorEnabled });
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});

//process on closing the appg
process.on('SIGINT', () => {
    gpioMapping.blue.unexport();
    gpioMapping.green.unexport();
    gpioMapping.yellow.unexport();
    gpioMapping.white.unexport();
    gpioMapping.red.unexport();

    i2c1.closeSync(); // Close I2C communication

    pir.unexport();

    process.exit();
});

