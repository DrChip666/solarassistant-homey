'use strict';

const UnitDriver = require('../../lib/unitDriver');

class GridDriver extends UnitDriver {

  get deviceNameKey() {
    return 'grid';
  }

  get pairShortcut() {
    return true;
  }

}

module.exports = GridDriver;
