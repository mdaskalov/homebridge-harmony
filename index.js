DEFAULT_HUB_PORT = '8088';
TIMEOUT_REFRESH_CURRENT_ACTIVITY = 1500;
CURRENT_ACTIVITY_NOT_SET_VALUE = -9999;
MAX_ATTEMPS_STATUS_UPDATE = 12;
DELAY_BETWEEN_ATTEMPS_STATUS_UPDATE = 2000;
DELAY_TO_UPDATE_STATUS = 800;

var Service, Characteristic, HomebridgeAPI;
var request = require('request');
const url = require('url');
const W3CWebSocket = require('websocket').w3cwebsocket;
const WebSocketAsPromised = require('websocket-as-promised');

function HarmonyPlatform(log, config) {
  this.log = log;
  this.hubIP = config['hubIP'];
  this.showTurnOffActivity = config['showTurnOffActivity'];
  this.name = config['name'];
  this.devMode = config['DEVMODE'];
  this.refreshTimer = config['refreshTimer'];
  this.skipedIfSameStateActivities = config['skipedIfSameStateActivities'];
  this._currentActivity = -9999;
  this._currentActivityLastUpdate = undefined;
  this._currentSetAttemps = 0;

  this.log.debug(
    'INFO : following activites controls will be ignored if they are in the same state : ' +
      this.skipedIfSameStateActivities
  );
}

module.exports = function(homebridge) {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  HomebridgeAPI = homebridge;
  homebridge.registerPlatform(
    'homebridge-harmonyHub',
    'HarmonyHubWebSocket',
    HarmonyPlatform
  );
};

HarmonyPlatform.prototype = {
  setTimer: function(on) {
    if (this.refreshTimer && this.refreshTimer > 0) {
      if (on && !this.timerID) {
        this.log.debug(
          'Setting Timer for background refresh every  : ' +
            this.refreshTimer +
            's'
        );
        this.timerID = setInterval(
          () => this.refreshAccessory(accessory),
          this.refreshTimer * 1000
        );
      } else if (!on && this.timerID) {
        this.log.debug('Clearing Timer');
        clearInterval(this.timerID);
      }
    }
  },

  accessories: function(callback) {
    this.log('Loading activities...');

    var that = this;

    var headers = {
      Origin: 'http://localhost.nebula.myharmony.com',
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'Accept-Charset': 'utf-8',
    };

    var hubUrl = `http://${this.hubIP}:${DEFAULT_HUB_PORT}/`;

    var jsonBody = {
      'id ': 1,
      cmd: 'connect.discoveryinfo?get',
      params: {},
    };

    var foundAccessories = [];

    request(
      {
        url: hubUrl,
        method: 'POST',
        headers: headers,
        body: jsonBody,
        json: true,
      },
      function(error, response, body) {
        if (error) {
          that.log('Error retrieving info from hub : ' + error.message);
        } else if (response && response.statusCode !== 200) {
          that.log(
            'Did not received 200 statuts, but  ' +
              response.statusCode +
              ' instead from hub'
          );
        } else if (body && body.data) {
          that.friendlyName = body.data.friendlyName;
          that.remote_id = body.data.remoteId;
          that.domain = url.parse(body.data.discoveryServerUri).hostname;
          that.email = body.data.email;
          that.account_id = body.data.accountId;

          wsUrl = `ws://${that.hubIP}:${DEFAULT_HUB_PORT}/?domain=${
            that.domain
          }&hubId=${that.remote_id}`;

          that.wsp = new WebSocketAsPromised(wsUrl, {
            createWebSocket: url => new W3CWebSocket(url),
            packMessage: data => JSON.stringify(data),
            unpackMessage: message => JSON.parse(message),
            attachRequestId: (data, requestId) => {
              data.hbus.id = requestId;
              return data;
            },
            extractRequestId: data => data && data.id,
          });

          params = {
            verb: 'get',
            format: 'json',
          };

          payload = {
            hubId: that.remote_id,
            timeout: 30,
            hbus: {
              cmd: `vnd.logitech.harmony/vnd.logitech.harmony.engine?config`,
              id: 0,
              params: params,
            },
          };

          that.wsp
            .open()
            .then(() =>
              that.wsp.onUnpackedMessage.addListener(data => {
                that.wsp.removeAllListeners();
                var services = [];

                that.log.debug('Hub config : ' + JSON.stringify(data));
                var activities = data.data.activity;

                for (var i = 0, len = activities.length; i < len; i++) {
                  if (activities[i].id != -1 || that.showTurnOffActivity) {
                    var switchName = activities[i].label;
                    if (that.devMode) {
                      switchName = 'DEV' + switchName;
                    }
                    that.log('Discovered Activity : ' + switchName);
                    var service = {
                      controlService: new Service.Switch(switchName),
                      characteristics: [Characteristic.On],
                    };
                    service.controlService.subtype = switchName;
                    service.controlService.id = activities[i].id;
                    services.push(service);
                  }
                }
                accessory = new HarmonyAccessory(services);
                accessory.getServices = function() {
                  return that.getServices(accessory);
                };
                accessory.platform = that;
                accessory.remoteAccessory = activities;
                accessory.name = that.name;
                accessory.model = 'Harmony';
                accessory.manufacturer = 'Harmony';
                accessory.serialNumber = that.hubIP;
                foundAccessories.push(accessory);

                //timer for background refresh
                that.setTimer(true);

                callback(foundAccessories);
              })
            )
            .then(() => that.wsp.sendPacked(payload))
            .catch(e => {
              that.log('ERROR : GetConfiguration :' + e);
              callback(foundAccessories);
            });
        } else {
          that.log(
            'Error : No config retrieved from hub, check IP and connectivity'
          );
          callback(foundAccessories);
        }
      }
    );
  },

  updateCharacteristic: function(characteristic, characteristicIsOn, callback) {
    try {
      if (callback) {
        callback(undefined, characteristicIsOn);
      } else {
        characteristic.updateValue(characteristicIsOn);
      }
    } catch (error) {
      characteristic.updateValue(characteristicIsOn);
    }
  },

  refreshCurrentActivity: function(callback) {
    if (
      this._currentActivity > CURRENT_ACTIVITY_NOT_SET_VALUE &&
      this._currentActivityLastUpdate &&
      Date.now() - this._currentActivityLastUpdate <
        TIMEOUT_REFRESH_CURRENT_ACTIVITY
    ) {
      // we don't refresh since status was retrieved not so far away
      this.log.debug(
        'INFO : NO refresh needed since last update was on :' +
          this._currentActivity +
          ' and current Activity is set'
      );
      callback();
    } else {
      this.log.debug(
        'INFO : Refresh needed since last update is too old or current Activity is not set : ' +
          this._currentActivity
      );

      params = {
        verb: 'get',
        format: 'json',
      };

      payload = {
        hubId: this.remote_id,
        timeout: 30,
        hbus: {
          cmd:
            'vnd.logitech.harmony/vnd.logitech.harmony.engine?getCurrentActivity',
          id: 0,
          params: params,
        },
      };

      this.wsp
        .open()
        .then(() =>
          this.wsp.onUnpackedMessage.addListener(data => {
            this.wsp.removeAllListeners();

            if (
              data &&
              data.data &&
              data.code &&
              (data.code == 200 || data.code == 100)
            ) {
              this._currentActivity = data.data.result;
              this._currentActivityLastUpdate = Date.now();
            } else {
              this.log.debug(
                'WARNING : could not refresh current Activity :' + data
                  ? JSON.stringify(data)
                  : 'no data'
              );
              this._currentActivity = CURRENT_ACTIVITY_NOT_SET_VALUE;
            }
            callback();
          })
        )
        .then(() => this.wsp.sendPacked(payload))
        .catch(e => {
          this.log('ERROR : RefreshCurrentActivity : ' + e);
          this._currentActivity = CURRENT_ACTIVITY_NOT_SET_VALUE;
          callback();
        });
    }
  },

  refreshService: function(service, homebridgeAccessory, callback) {
    var serviceControl = service.controlService;
    var characteristic = serviceControl.getCharacteristic(Characteristic.On);

    this.refreshCurrentActivity(() => {
      if (this._currentActivity > CURRENT_ACTIVITY_NOT_SET_VALUE) {
        var characteristicIsOn = this._currentActivity == serviceControl.id;

        this.log.debug(
          'Got status for ' +
            serviceControl.displayName +
            ' - was ' +
            characteristic.value +
            ' set to ' +
            characteristicIsOn
        );
        homebridgeAccessory.platform.updateCharacteristic(
          characteristic,
          characteristicIsOn,
          callback
        );
      } else {
        this.log.debug('WARNING : no current Activity');
        homebridgeAccessory.platform.updateCharacteristic(
          characteristic,
          characteristic.value,
          callback
        );
      }
    });
  },

  refreshAccessory: function(homebridgeAccessory) {
    for (var s = 0; s < homebridgeAccessory.services.length; s++) {
      var service = homebridgeAccessory.services[s];
      homebridgeAccessory.platform.refreshService(
        service,
        homebridgeAccessory,
        undefined
      );
    }
  },

  command: function(cmd, params, homebridgeAccessory) {
    //timer for background refresh
    this.setTimer(false);

    payload = {
      hubId: this.remote_id,
      timeout: 30,
      hbus: {
        cmd: cmd,
        id: 0,
        params: params,
      },
    };

    this.wsp
      .open()
      .then(() =>
        this.wsp.onUnpackedMessage.addListener(data => {
          this.wsp.removeAllListeners();
          if (
            data &&
            data.code &&
            data.code == 200 &&
            data.msg &&
            data.msg == 'OK'
          ) {
            this._currentSetAttemps = 0;

            for (var s = 0; s < homebridgeAccessory.services.length; s++) {
              var serviceControl =
                homebridgeAccessory.services[s].controlService;
              var characteristic = serviceControl.getCharacteristic(
                Characteristic.On
              );

              if (serviceControl.id == params.activityId) {
                this.log(serviceControl.displayName + ' activated');
              }

              //we disable previous activiies that were on
              if (
                serviceControl.id != -1 &&
                serviceControl.id != params.activityId &&
                characteristic.value
              ) {
                this.log.debug('Switching off ' + serviceControl.displayName);
                characteristic.updateValue(false);
              }

              //we turn off Off Activity if another activity was launched
              if (serviceControl.id == -1 && params.activityId != -1) {
                this.log.debug(
                  'New activity on , turning off off Activity ' +
                    serviceControl.displayName
                );
                characteristic.updateValue(false);
              }

              //we turn on Off Activity if we turned off an activity (or turn on the general switch)
              if (serviceControl.id == -1 && params.activityId == -1) {
                this.log.debug(
                  'Turning on off Activity ' + serviceControl.displayName
                );
                characteristic.updateValue(true);
              }
            }
            this._currentActivity = params.activityId;
            //timer for background refresh
            this.setTimer(true);
          } else if (data) {
            if (data.code == 202 || data.code == 100) {
              this._currentSetAttemps = this._currentSetAttemps + 1;
              //get characteristic
              this.log.debug(
                'WARNING : could not SET status : ' + JSON.stringify(data)
              );

              var charactToSet;
              for (var s = 0; s < homebridgeAccessory.services.length; s++) {
                var serviceControl =
                  homebridgeAccessory.services[s].controlService;
                var characteristic = serviceControl.getCharacteristic(
                  Characteristic.On
                );
                if (serviceControl.id == params.activityId) {
                  charactToSet = characteristic;
                  break;
                }
              }

              //we try again with a delay of 1sec since an activity is in progress and we couldn't update the one.
              var that = this;
              setTimeout(function() {
                if (that._currentSetAttemps < MAX_ATTEMPS_STATUS_UPDATE) {
                  that.log.debug(
                    'RETRY to SET ON : ' + serviceControl.displayName
                  );
                  charactToSet.setValue(true, callback, undefined);
                } else {
                  that.log(
                    'ERROR : could not SET status, no more RETRY : ' +
                      +serviceControl.displayName
                  );
                  charactToSet.updateValue(false);
                  //timer for background refresh
                  that.setTimer(true);
                }
              }, DELAY_BETWEEN_ATTEMPS_STATUS_UPDATE);
            }
          } else {
            this.log('ERROR : could not SET status, no data');
            //timer for background refresh
            this.setTimer(true);
          }
        })
      )
      .then(() => this.wsp.sendPacked(payload))
      .catch(e => {
        this.log('ERROR : sendCommand :' + e);
        //timer for background refresh
        this.setTimer(true);
      });
  },

  bindCharacteristicEvents: function(
    characteristic,
    service,
    homebridgeAccessory
  ) {
    characteristic.on(
      'set',
      function(value, callback, context) {
        var doCommand = true;
        var commandToSend = value ? service.controlService.id : '-1';
        var currentValue = characteristic.value;
        //Actitiy in skipedIfSameState
        if (
          this.skipedIfSameStateActivities &&
          this.skipedIfSameStateActivities.includes(
            service.controlService.subtype
          )
        ) {
          this.log.debug(
            'INFO : SET on an activty in skipedIfsameState list ' +
              service.controlService.subtype
          );

          this.log.debug(
            'INFO : Activty ' +
              service.controlService.subtype +
              ' is ' +
              currentValue +
              ', wants to set to ' +
              value
          );
          //GLOBAL OFF SWITCH : do command only if it is off and we want to set it on since on state can't be reversed
          if (service.controlService.id == -1) {
            doCommand = !currentValue && value;
          }
          //ELSE, we do the command only if state is different.
          else {
            doCommand = currentValue != value;
          }
          if (doCommand) {
            this.log.debug(
              'INFO : Activty ' +
                service.controlService.subtype +
                ' will be sent command ' +
                commandToSend
            );
          } else {
            this.log.debug(
              'INFO : Activty ' +
                service.controlService.subtype +
                ' will not be sent any command '
            );
          }
        } else {
          this.log.debug(
            'INFO : SET on an activty not in skipedIfsameState list ' +
              service.controlService.subtype
          );
        }

        if (doCommand) {
          params = {
            async: 'true',
            timestamp: 0,
            args: {
              rule: 'start',
            },
            activityId: commandToSend,
          };
          cmd = 'harmony.activityengine?runactivity';
          homebridgeAccessory.platform.command(
            cmd,
            params,
            homebridgeAccessory
          );
          callback();
        } else {
          callback();
          setTimeout(function() {
            characteristic.updateValue(currentValue);
          }, DELAY_TO_UPDATE_STATUS);
        }
      }.bind(this)
    );
    characteristic.on(
      'get',
      function(callback) {
        homebridgeAccessory.platform.refreshService(
          service,
          homebridgeAccessory,
          callback
        );
      }.bind(this)
    );
  },

  getInformationService: function(homebridgeAccessory) {
    var informationService = new Service.AccessoryInformation();
    informationService
      .setCharacteristic(Characteristic.Name, homebridgeAccessory.name)
      .setCharacteristic(
        Characteristic.Manufacturer,
        homebridgeAccessory.manufacturer
      )
      .setCharacteristic(Characteristic.Model, homebridgeAccessory.model)
      .setCharacteristic(
        Characteristic.SerialNumber,
        homebridgeAccessory.serialNumber
      );
    return informationService;
  },

  getServices: function(homebridgeAccessory) {
    var services = [];
    var informationService = homebridgeAccessory.platform.getInformationService(
      homebridgeAccessory
    );
    services.push(informationService);
    for (var s = 0; s < homebridgeAccessory.services.length; s++) {
      var service = homebridgeAccessory.services[s];
      for (var i = 0; i < service.characteristics.length; i++) {
        var characteristic = service.controlService.getCharacteristic(
          service.characteristics[i]
        );
        if (characteristic == undefined)
          characteristic = service.controlService.addCharacteristic(
            service.characteristics[i]
          );
        homebridgeAccessory.platform.bindCharacteristicEvents(
          characteristic,
          service,
          homebridgeAccessory
        );
      }
      services.push(service.controlService);
    }
    return services;
  },
};

function HarmonyAccessory(services) {
  this.services = services;
}
