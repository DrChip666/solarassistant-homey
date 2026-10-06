'use strict';

/**
 * Turns SolarAssistant's period-to-date kWh values into an ever-increasing total.
 *
 * SolarAssistant's kWh topics reset daily/weekly/monthly (the unit's own "Reset
 * energy totals" setting), but Homey's Energy dashboard works from the difference
 * between meter_power readings and expects a counter that only ever grows.
 * Resets to zero or decreases would otherwise cause data loss or invalid readings.
 *
 * State is a plain object ({ [key]: { last, sum } }) so it can be stored in the
 * device store and survive restarts.
 */
class EnergyAccumulator {

  constructor(state) {
    this.state = state && typeof state === 'object' ? state : {};
    this.dirty = false;
  }

  /** Feed a raw reading, get the accumulated total back. */
  update(key, rawValue) {
    let entry = this.state[key];

    if (!entry) {
      // First reading ever: start counting from here.
      entry = { last: rawValue, sum: rawValue };
    } else if (rawValue >= entry.last) {
      // Normal increase within the same period.
      entry.sum += (rawValue - entry.last);
      entry.last = rawValue;
    } else {
      // The raw value dropped, so SolarAssistant's period counter was reset.
      // Add the new value as the amount collected since the reset, rather than
      // a (negative) difference against the old value.
      entry.sum += rawValue;
      entry.last = rawValue;
    }

    this.state[key] = entry;
    this.dirty = true;
    return entry.sum;
  }

}

module.exports = EnergyAccumulator;
