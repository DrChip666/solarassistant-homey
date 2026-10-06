'use strict';

const UnitDriver = require('../../lib/unitDriver');

class SolarAssistantDriver extends UnitDriver {

  get deviceNameKey() {
    return 'overview';
  }

  async onInit() {
    this.gridDirectionTrigger = this.homey.flow.getDeviceTriggerCard('grid_direction_changed');

    this.homey.flow.getConditionCard('battery_soc_above')
      .registerRunListener(async (args) => {
        const soc = args.device.getCapabilityValue('measure_battery');
        return typeof soc === 'number' && soc > args.percentage;
      });

    this.homey.flow.getActionCard('send_command')
      .registerRunListener(async (args) => {
        await args.device.sendCommand(args.topic, args.value);
      });
  }

  /** Called by device.js when the grid direction switches between import and export. */
  triggerGridDirectionChanged(device, tokens) {
    this.gridDirectionTrigger.trigger(device, tokens)
      .catch((err) => this.error('Failed to trigger grid_direction_changed:', err.message));
  }

}

module.exports = SolarAssistantDriver;
