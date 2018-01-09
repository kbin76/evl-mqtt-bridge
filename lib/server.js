// Copyright 2016 the project authors as listed in the AUTHORS file.
// All rights reserved. Use of this source code is governed by the
// license that can be found in the LICENSE file.
"use strict";

const https = require('https');
const mqtt = require('mqtt');
const nap = require('nodealarmproxy');
const notify = require('micro-app-notify-client');

var alarm;

// function to execute commands.  In an error occurs
// the first parameter of the callback will be an
// error object. The command to be executed is
// passed in command, and expectedAction is an
// object with the action (ex partitionupdate) and
// the code (ex '656') which is expected in response
// to the command
var executeCommand = function(command, expectedAction, callback) {
  var waitAction = function(data) {
    if (data.code === expectedAction.code) {
      alarm.removeListener(expectedAction.action, waitAction);
      callback();
    }
  }

  alarm.on(expectedAction.action, waitAction);
  nap.manualCommand(command, function(err) {
    if (err) {
      alarm.removeListener(expectedAction.action, waitAction);
      callback(err);
    }
  });
}


var arm = function(callback) {
  var attempts = 0;
  executeCommand('0301', { action: 'partitionupdate', code: '656' }, function(err) {
    if (err === '024') {
      if (attempts === 0) {
        // get get the panel busy error if the panal has blanked.
        // wake up the panel with a # keystroke and then try again
        attempts++;
        executeCommand('070#', {action: 'partitionupdate', code: '650'},
          arm.bind(this, callback));
      } else {
        callback(err);
      }
    } else {
      callback();
    }
  });
}


var disarm = function(code, callback) {
  executeCommand('0401' + code, {'action': 'partitionupdate', code: '655' }, callback);
}


///////////////////////////////////////////////
// micro-app framework methods
///////////////////////////////////////////////
var Server = function() {
}

Server.getDefaults = function() {
  return { 'title': 'Alarm Console' };
}


var replacements;
Server.getTemplateReplacments = function() {
  if (replacements === undefined) {
    var config = Server.config;
    replacements = [{ 'key': '<DASHBOARD_TITLE>', 'value': config.title },
                    { 'key': '<UNIQUE_WINDOW_ID>', 'value': config.title },
                    { 'key': '<PAGE_WIDTH>', 'value': PAGE_WIDTH },
                    { 'key': '<PAGE_HEIGHT>', 'value': PAGE_HEIGHT }];

  }
  return replacements;
}


Server.startServer = function(server) {
	const config = Server.config;

	var zoneStatus = {};
	var partitionStatus = {};

	var mqttOptions;
	if (config.mqtt.serverUrl.indexOf('mqtts') > -1) {
		mqttOptions = { key: fs.readFileSync(path.join(__dirname, 'mqttclient', '/client.key')),
			cert: fs.readFileSync(path.join(__dirname, 'mqttclient', '/client.cert')),
			ca: fs.readFileSync(path.join(__dirname, 'mqttclient', '/ca.cert')),
			checkServerIdentity: function() { return undefined }
		}
	}
	const mqttClient = mqtt.connect(config.mqtt.serverUrl, mqttOptions);

	mqttClient.on('connect',function() {
		mqttClient.subscribe(config.mqtt.controlTopic);
	});

	// allow alarm to be turned on/off through mqtt.  To turn off
	// you must provide the alarm code as disarmXXXX where XXXX
	// is the code for the alarm
	mqttClient.on('message', function(topic, message) {
		message = message.toString();
		if (message === 'arm') {
			arm(function() {});
		} else if (message.startsWith('disarm')) {
			disarm(message.substr('disarm'.length), function() {});
		}
	});

	const connectToAlarm = function() {
		alarm = nap.initConfig(config.evlConfig);

		// Zone Updates
		//
		alarm.on('zoneupdate', function(data) {
			console.log("zoneupdate: " + JSON.stringify(data));

			// Publish event as JSON (if we've configured eventAsJSONTopic)
			if( config.mqtt.eventAsJSONTopic && config.mqtt.eventAsJSONTopic != "") {
				mqttClient.publish(config.mqtt.eventAsJSONTopic, JSON.stringify(data));
			}

			// Raw Zone Topic
			if (config.mqtt.rawZoneTopic) {
				mqttClient.publish(config.mqtt.rawZoneTopic, data.zone + ':' + data.code);
			}

			// Boolean event topic
			if( config.mqtt.booleanEventTopic) {
				var topicBase = config.mqtt.booleanEventTopic + "/z" + data.zone + "_";
				var true_value = "on";
				var false_value = "off";
				switch(data.status) {
				case "open": mqttClient.publish( topicBase + "open", true_value); break;
				case "openrestore": 
					mqttClient.publish( topicBase + "open", false_value);
					if( !zoneStatus[data.zone] || !zoneStatus[data.zone].seenBefore) {
						mqttClient.publish( topicBase + "alarm", false_value); 
						mqttClient.publish( topicBase + "fault", false_value); 
						mqttClient.publish( topicBase + "tamper", false_value); 
						zoneStatus[data.zone] = { seenBefore: true };
					}
					break;
				case "alarm": mqttClient.publish( topicBase + "alarm", true_value); break;
				case "alarmrestore": mqttClient.publish( topicBase + "alarm", false_value); break;
				case "fault": mqttClient.publish( topicBase + "fault", true_value); break;
				case "faultrestore": mqttClient.publish( topicBase + "fault", false_value); break;
				case "tamper": mqttClient.publish( topicBase + "tamper", true_value); break;
				case "tamperrestore": mqttClient.publish( topicBase + "tamper", false_value); break;
				}
			}

			// Topic Map
			if (config.mqtt.topicMap) {
				const map = config.mqtt.topicMap[data.zone + '-' + data.code];
				if (map) {
					mqttClient.publish(map.topic, map.message);
				}
			}
		});

		// System Updates
		//
		alarm.on('systemupdate', function(data) {
			console.log("systemupdate: " + JSON.stringify(data));
			// Publish event as JSON (if we've configured eventAsJSONTopic)
			if( config.mqtt.eventAsJSONTopic && config.mqtt.eventAsJSONTopic != "") {
				mqttClient.publish(config.mqtt.eventAsJSONTopic, JSON.stringify(data));
			}

			//systemupdate: {"evtType":"systemUpdate","code":"840","status":"troubleledon","partition":1}
			//{"evtType":"systemUpdate","code":"849","status":"verbosetroublestatus","troubleStatus":["FAILURE_TO_COMMUNICATE"]}
			if( config.mqtt.booleanEventTopic) {
				var topicBase = config.mqtt.booleanEventTopic + "/sys_";
				var true_value = "on";
				var false_value = "off";
				switch(data.status) {
				case "verbosetroublestatus":
					for( var bn in data.troubleStatus) {
						mqttClient.publish( topicBase + bn, data.troubleStatus[bn] ? true_value : false_value);
					}
					break;
				}
			}

		});

		// Partition Updates
		//
		alarm.on('partitionupdate', function(data) {
			console.log("partitionupdate: " + JSON.stringify(data));

			// Publish event as JSON (if we've configured eventAsJSONTopic)
			if( config.mqtt.eventAsJSONTopic && config.mqtt.eventAsJSONTopic != "") {
				mqttClient.publish(config.mqtt.eventAsJSONTopic, JSON.stringify(data));
			}

			// Boolean event topic
			if( config.mqtt.booleanEventTopic) {
				var topicBase = config.mqtt.booleanEventTopic + "/p" + data.partition + "_";
				var true_value = "on";
				var false_value = "off";
				switch(data.status) {

				// "States" - of either on/off or true/false states
				case "readyforce":
				case "ready":
					mqttClient.publish( topicBase + "ready", true_value);
					mqttClient.publish( topicBase + "busy", false_value);
					break;
				case "notready":
					mqttClient.publish( topicBase + "ready", false_value);
					break;
				case "armed":
					mqttClient.publish( topicBase + "armed", true_value);
					mqttClient.publish( topicBase + "exitdelay", false_value);
					mqttClient.publish( topicBase + "entrydelay", false_value);
					mqttClient.publish( topicBase + "alarm", false_value);
					// TODO: test if this works
					if( data.armMode == "away" || data.armMode=="zero-entry-away") {
						mqttClient.publish( topicBase + "stayarm", false_value);
						mqttClient.publish( topicBase + "awayarm", true_value);
					} else if( data.armMode == "stay" || data.armMode=="zero-entry-stay") {
						mqttClient.publish( topicBase + "stayarm", true_value);
						mqttClient.publish( topicBase + "awayarm", false_value);
					}
					break;
				case "disarmed":
					mqttClient.publish( topicBase + "armed", false_value);
					mqttClient.publish( topicBase + "entrydelay", false_value);
					mqttClient.publish( topicBase + "exitdelay", false_value);
					mqttClient.publish( topicBase + "stayarm", false_value);
					mqttClient.publish( topicBase + "awayarm", false_value);
					break;
				case "alarm":
					mqttClient.publish( topicBase + "alarm", true_value);
					break;
				case "exitdelay":
					mqttClient.publish( topicBase + "exitdelay", true_value);
					break;
				case "entrydelay":
					mqttClient.publish( topicBase + "entrydelay", true_value);
					break;
				case "busy":
					mqttClient.publish( topicBase + "busy", true_value);
					break;
				case "chimeenabled":
					mqttClient.publish( topicBase + "chimeenabled", true_value);
					break;
				case "chimedisabled":
					mqttClient.publish( topicBase + "chimeenabled", false_value);
					break;
				case "troubleledon":
					mqttClient.publish( topicBase + "trouble", true_value);
					break;
				case "troubleledoff":
					mqttClient.publish( topicBase + "trouble", false_value);
					break;

				// TODO: test if this works
				case "useropening":
				case "userclosing":
					topicBase += "u" + data.userId + "_";
					mqttClient.publish( topicBase + data.status, true_value);
					mqttClient.publish( topicBase + data.status, false_value);
					break;

				// "Events" - generates on then off to indicate event occured (but not of static nature)
				case "failedtoarm":
					mqttClient.publish( topicBase + "exitdelay", false_value);
				case "autoarming":
				case "keypadlockout":
				case "pgmoutputinprogress":
				case "invalidcode":
				case "functionnotavailable":
				case "specialclosing":
				case "partialclosing":
				case "specialopening":
					mqttClient.publish( topicBase + data.status, true_value);
					mqttClient.publish( topicBase + data.status, false_value);
					break;
				}
			}

			// Raw partition topic
			if (config.mqtt.rawPartTopic) {
				mqttClient.publish(config.mqtt.rawPartTopic, data.code);
			}

			// Topic Map
			if (config.mqtt.topicMap) {
				const map = config.mqtt.topicMap['part-' + data.code];
				if (map) {
					mqttClient.publish(map.topic, map.message);
				}
			}

			var code = data.code;
			// convert a few of the common codes to more readable constants
			if (code === '654') {
				code = 'alarm';
			} else if (code === '655') {
				code = 'disarm';
			} else if (code === '652') {
				code = 'arm';
			}

			if (config.sms[code]) {
				notify.sendNotification(config, 'Alarm partition update:' + code);
			}
		});

		alarm.on('error', function(err) {
			console.log('Error:' + err);
			console.log('Reconnecting');
			setTimeout( () => connectToAlarm(), 5000);
		});
	}
	connectToAlarm();
}


if (require.main === module) {
	var path = require('path');
	var microAppFramework = require('micro-app-framework');
	microAppFramework(path.join(__dirname), Server);
}


module.exports = Server;
