'use strict';

const UnitDevice = require('../../lib/unitDevice');

// SolarAssistant reports grid power as positive when importing and negative when exporting.
const TOPICS = {
  'total/grid_power': { capability: 'measure_power' },
  'total/grid_energy_in': { capability: 'meter_power.imported', energy: true },
  'total/grid_energy_out': { capability: 'meter_power.exported', energy: true },
};

class GridDevice extends UnitDevice {

  get topicMap() {
    return TOPICS;
  }

}

module.exports = GridDevice;
