'use strict';

const UnitDriver = require('../../lib/unitDriver');
const SolarAssistantClient = require('../../lib/solarAssistantClient');
const { buildTopicDevices } = require('../../lib/topicCatalog');

/**
 * "SolarAssistant value": the user picks any of the values the unit can deliver
 * (Status and Info) from a list, and gets one Homey device per value.
 */
class TopicDriver extends UnitDriver {

  get pairShortcut() {
    return true;
  }

  /** One device per value the unit offers. The list is read from the unit itself. */
  async _unitToDevices(unit, { multi = false } = {}) {
    const client = new SolarAssistantClient({
      address: unit.address,
      password: unit.password,
      homey: this.homey,
      log: this.log.bind(this),
    });

    let metrics;
    try {
      metrics = await client.fetchMetrics();
    } catch (err) {
      this.error('Could not read the values of the SolarAssistant unit:', err.message);
      throw new Error(this.homey.__('pair.unreachable'));
    } finally {
      client.destroy();
    }

    return buildTopicDevices(metrics, unit, {
      // With more than one unit, the list says which one each value belongs to.
      prefix: multi ? `[${unit.address}] ` : '',
      t: (key) => this.homey.__(key),
    });
  }

}

module.exports = TopicDriver;
