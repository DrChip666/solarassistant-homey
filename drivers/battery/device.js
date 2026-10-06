'use strict';

const UnitDevice = require('../../lib/unitDevice');

// Homey Energy: a home battery's measure_power is positive while charging and negative
// while discharging. SolarAssistant uses the same sign, so the value is passed on as it is.
const TOPICS = {
  'total/battery_power': { capability: 'measure_power' },
  'total/battery_state_of_charge': { capability: 'measure_battery', transform: (percent) => Math.min(100, Math.max(0, percent)) },
  'total/battery_energy_in': { capability: 'meter_power.charged', energy: true },
  'total/battery_energy_out': { capability: 'meter_power.discharged', energy: true },
};

class BatteryDevice extends UnitDevice {

  get topicMap() {
    return TOPICS;
  }

}

module.exports = BatteryDevice;
