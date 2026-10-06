'use strict';

const UnitDevice = require('../../lib/unitDevice');

// Mapping from SolarAssistant "topic" to Homey capability.
// See: https://solar-assistant.io/help/integration/rest-api
const TOPICS = {
  'total/pv_power': { capability: 'measure_power.pv' },
  'total/load_power': { capability: 'measure_power.load' },
  'total/battery_power': { capability: 'measure_power.battery' },
  'total/grid_power': { capability: 'measure_power.grid' },
  'total/battery_state_of_charge': { capability: 'measure_battery' },
  'total/pv_energy': { capability: 'meter_power.pv', energy: true },
  'total/load_energy': { capability: 'meter_power.load', energy: true },
  'total/grid_energy_in': { capability: 'meter_power.grid_import', energy: true },
  'total/grid_energy_out': { capability: 'meter_power.grid_export', energy: true },
  'total/battery_energy_in': { capability: 'meter_power.battery_in', energy: true },
  'total/battery_energy_out': { capability: 'meter_power.battery_out', energy: true },
  'total/inverter_mode': { capability: 'inverter_mode', string: true },
  // Fallback for units that do not publish total/inverter_mode.
  'inverter_1/device_mode': { capability: 'inverter_mode', string: true },
};

/**
 * The original all-in-one device: every value in one place, plus the Flow cards.
 * It is kept as it was, so existing Flows and Insights keep working. The separate
 * Solar, Battery and Grid devices are what Homey Energy understands.
 */
class SolarAssistantDevice extends UnitDevice {

  get topicMap() {
    return TOPICS;
  }

  async onUnitInit() {
    this.lastGridDirection = null;
    this._seenTotalMode = false;
  }

  handleMetrics(metrics) {
    // Prefer total/inverter_mode when the unit publishes it (inverter_1/device_mode is the fallback).
    if (!this._seenTotalMode && metrics.some((m) => m && m.topic === 'total/inverter_mode')) {
      this._seenTotalMode = true;
    }
    const usable = this._seenTotalMode
      ? metrics.filter((m) => !(m && m.topic === 'inverter_1/device_mode'))
      : metrics;

    this.applyTopicMap(usable);

    for (const metric of usable) {
      if (metric && metric.topic === 'total/grid_power' && metric.value !== null && metric.value !== undefined) {
        const watt = Number(metric.value);
        if (!Number.isNaN(watt)) this._handleGridDirection(watt);
      }
    }
  }

  _handleGridDirection(gridPowerWatt) {
    // According to SolarAssistant, negative = exporting to the grid.
    const direction = gridPowerWatt < 0 ? 'export' : 'import';

    if (this.lastGridDirection !== null && this.lastGridDirection !== direction) {
      const label = direction === 'export'
        ? this.homey.__('flow.direction_export')
        : this.homey.__('flow.direction_import');

      this.driver.triggerGridDirectionChanged(this, { direction: label });
    }

    this.lastGridDirection = direction;
  }

}

module.exports = SolarAssistantDevice;
