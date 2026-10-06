'use strict';

const UnitDriver = require('../../lib/unitDriver');

class SolarDriver extends UnitDriver {

  get deviceNameKey() {
    return 'solar';
  }

  get pairShortcut() {
    return true;
  }

}

module.exports = SolarDriver;
