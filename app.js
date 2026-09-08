'use strict';

const Homey = require('homey');

class SolarAssistantApp extends Homey.App {

  async onInit() {
    this.log('SolarAssistant app has started');
  }

}

module.exports = SolarAssistantApp;
