'use strict';

const UnitDevice = require('../../lib/unitDevice');

// Homey Energy: a solar panel's measure_power is positive while generating, and a
// negative value would be read as the panel consuming power.
const TOPICS = {
  'total/pv_power': { capability: 'measure_power', transform: (watt) => Math.max(0, watt) },
  'total/pv_energy': { capability: 'meter_power', energy: true },
};

class SolarDevice extends UnitDevice {

  get topicMap() {
    return TOPICS;
  }

}

module.exports = SolarDevice;
