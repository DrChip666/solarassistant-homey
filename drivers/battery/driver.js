'use strict';

const UnitDriver = require('../../lib/unitDriver');

class BatteryDriver extends UnitDriver {

  get deviceNameKey() {
    return 'battery';
  }

  get pairShortcut() {
    return true;
  }

}

module.exports = BatteryDriver;
