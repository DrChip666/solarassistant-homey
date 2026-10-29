'use strict';

const UnitDevice = require('../../lib/unitDevice');

// The battery level is shown either as a real battery (measure_battery, which makes Homey
// warn about a low battery) or as a plain percentage, depending on the setting
// "Report battery level to Homey as a battery".
const BATTERY_STANDARD = 'measure_battery';
const BATTERY_PLAIN = 'measure_sa_battery';

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
    return this._topicMap || TOPICS;
  }

  async onUnitInit() {
    this.lastGridDirection = null;
    this._seenTotalMode = false;
    await this._applyBatteryMode(this._reportsBattery());
  }

  /** The setting is on by default, and devices from before the setting existed count as on. */
  _reportsBattery(settings = this.getSettings()) {
    return !settings || settings.report_battery !== false;
  }

  /**
   * Make the device carry the battery level the way the setting asks for. Nothing happens when it
   * already does, so existing devices (setting on) keep their capability, Flows and history.
   */
  async _applyBatteryMode(report) {
    const keep = report ? BATTERY_STANDARD : BATTERY_PLAIN;
    const drop = report ? BATTERY_PLAIN : BATTERY_STANDARD;

    this._topicMap = { ...TOPICS, 'total/battery_state_of_charge': { capability: keep } };

    if (!this.hasCapability(keep)) await this.addCapability(keep);

    if (this.hasCapability(drop)) {
      // Keep showing the last known level until the next value arrives.
      const last = this.getCapabilityValue(drop);
      if (typeof last === 'number') await this.setCapabilityValue(keep, last).catch(() => {});
      await this.removeCapability(drop);
    }
  }

  /** The battery level, whichever way it is reported. Used by the "battery above" Flow condition. */
  getBatteryLevel() {
    for (const capability of [BATTERY_STANDARD, BATTERY_PLAIN]) {
      if (this.hasCapability(capability)) {
        const value = this.getCapabilityValue(capability);
        if (typeof value === 'number') return value;
      }
    }
    return null;
  }

  async onSettings(args) {
    await super.onSettings(args);
    if (args.changedKeys.includes('report_battery')) {
      await this._applyBatteryMode(this._reportsBattery(args.newSettings));
    }
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
