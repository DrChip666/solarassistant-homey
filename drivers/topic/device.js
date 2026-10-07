'use strict';

const UnitDevice = require('../../lib/unitDevice');

/**
 * Shows one single value from the SolarAssistant unit. Which value, and with which
 * capability, was decided when the device was added (see lib/topicCatalog.js).
 *
 * The device is read-only and is not part of Homey Energy: it uses sensor-style
 * capabilities, never measure_power / meter_power.
 */
class TopicDevice extends UnitDevice {

  async onUnitInit() {
    this.topic = this.getData().topic;
    this.kind = this.getStoreValue('kind') || 'number';

    this._topicMap = {
      [this.topic]: {
        capability: this.getCapabilities()[0],
        string: this.kind === 'string',
        boolean: this.kind === 'boolean',
      },
    };
  }

  get topicMap() {
    return this._topicMap || {};
  }

  /** Ask the unit to stream this value live. */
  getTopics() {
    const { topic } = this.getData();
    return topic ? [topic] : [];
  }

}

module.exports = TopicDevice;
