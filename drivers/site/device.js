'use strict';

const Homey = require('homey');
const SolarAssistantClient = require('../../lib/solarAssistantClient');

// Mapping from SolarAssistant "topic" to Homey capability.
// See: https://solar-assistant.io/help/integration/rest-api
const TOPIC_CAPABILITY_MAP = {
  'total/pv_power': 'measure_power.pv',
  'total/load_power': 'measure_power.load',
  'total/battery_power': 'measure_power.battery',
  'total/grid_power': 'measure_power.grid',
  'total/battery_state_of_charge': 'measure_battery',
  'total/pv_energy': 'meter_power.pv',
  'total/load_energy': 'meter_power.load',
  'total/grid_energy_in': 'meter_power.grid_import',
  'total/grid_energy_out': 'meter_power.grid_export',
  'total/battery_energy_in': 'meter_power.battery_in',
  'total/battery_energy_out': 'meter_power.battery_out',
  'total/inverter_mode': 'inverter_mode',
  // Fallback for units that do not publish total/inverter_mode.
  'inverter_1/device_mode': 'inverter_mode',
};

const STRING_CAPABILITIES = new Set(['inverter_mode']);

// SolarAssistant's kWh topics are period-to-date (they reset daily/weekly/monthly,
// depending on the device's own "Reset energy totals" setting), but Homey's Energy
// dashboard expects meter_power capabilities to be an ever-increasing lifetime total.
// We therefore accumulate our own running total for these, instead of forwarding
// SolarAssistant's raw (periodically-resetting) values directly.
const ENERGY_CAPABILITIES = new Set([
  'meter_power.pv',
  'meter_power.load',
  'meter_power.grid_import',
  'meter_power.grid_export',
  'meter_power.battery_in',
  'meter_power.battery_out',
]);

// The device is marked unavailable when neither a live message nor a REST response
// has arrived for this long (e.g. power cut, network problem, unit rebooting).
const STALE_AFTER_MS = 2 * 60 * 1000;
const WATCHDOG_INTERVAL_MS = 15 * 1000;

class SolarAssistantDevice extends Homey.Device {

  async onInit() {
    this.lastGridDirection = null;
    this.reconnectTimer = null;
    this._connecting = false;
    this._reconnectRequested = false;
    this._energyStateDirty = false;
    this._seenTotalMode = false;
    // Homey remembers availability across restarts, so start from the real state.
    this._unavailable = !this.getAvailable();
    this._lastDataAt = Date.now();
    // { [capability]: { last: number|null, sum: number|null } }, persisted across restarts.
    this.energyState = this.getStoreValue('energyState') || {};

    this._watchdog = this.homey.setInterval(() => this._checkFreshness(), WATCHDOG_INTERVAL_MS);
    await this._connect();
  }

  /**
   * (Re)create the connection to the SolarAssistant unit.
   * @param {object} [options]
   * @param {boolean} [options.force] Used for changed settings: if a connection attempt is
   *   already running, run another one afterwards instead of skipping the request.
   */
  async _connect({ force = false } = {}) {
    // Guard against overlapping calls - e.g. onInit() and a discovery callback can both
    // fire around startup and would otherwise open duplicate connections.
    if (this._connecting) {
      if (force) this._reconnectRequested = true;
      return;
    }
    this._connecting = true;

    try {
      const settings = this.getSettings();
      const password = this.getStoreValue('password');

      if (this.client) {
        this.client.destroy();
        this.client = null;
      }

      const client = new SolarAssistantClient({
        address: settings.address,
        password,
        token: settings.token,
        preferredWsPath: this.getStoreValue('wsPath'),
        homey: this.homey,
        log: (...args) => this.log(...args),
      });
      this.client = client;

      client.on('metrics', (metrics) => this._handleMetrics(metrics));
      client.on('alive', () => this._markAlive());
      client.on('wspath', (path) => {
        // Remember which websocket path this unit's firmware uses.
        this.setStoreValue('wsPath', path).catch((err) => {
          this.error('Could not store websocket path:', err.message);
        });
      });
      client.on('error', (err) => {
        this.error('SolarAssistant error:', err && err.message ? err.message : err);
      });

      try {
        await client.testConnection();
        this._markAlive();
      } catch (err) {
        this.error('Could not connect to SolarAssistant:', err.message);
        this._markUnavailable();
      }

      // Starts polling and the websocket. Polling keeps retrying even if the first attempt failed.
      await client.start(settings.poll_interval || 5);
    } finally {
      this._connecting = false;
    }

    if (this._reconnectRequested) {
      this._reconnectRequested = false;
      await this._connect();
    }
  }

  // --- Availability --------------------------------------------------------

  _markAlive() {
    this._lastDataAt = Date.now();
    if (this._unavailable) {
      this._unavailable = false;
      this.setAvailable().catch((err) => {
        this.error('Could not mark device available:', err.message);
      });
    }
  }

  _markUnavailable() {
    if (this._unavailable) return;
    this._unavailable = true;
    this.setUnavailable(this.homey.__('device.connection_error')).catch(() => {});
  }

  _checkFreshness() {
    if (!this._unavailable && Date.now() - this._lastDataAt > STALE_AFTER_MS) {
      this.log('No data from SolarAssistant for 2 minutes, marking the device unavailable');
      this._markUnavailable();
    }
  }

  // --- Incoming values -----------------------------------------------------

  _handleMetrics(metrics) {
    if (!Array.isArray(metrics)) return;

    // Prefer total/inverter_mode when the unit publishes it (inverter_1/device_mode is the fallback).
    if (!this._seenTotalMode && metrics.some((m) => m && m.topic === 'total/inverter_mode')) {
      this._seenTotalMode = true;
    }

    this._energyStateDirty = false;

    for (const metric of metrics) {
      if (!metric) continue;
      if (metric.topic === 'inverter_1/device_mode' && this._seenTotalMode) continue;

      const capability = TOPIC_CAPABILITY_MAP[metric.topic];
      if (!capability || !this.hasCapability(capability)) continue;

      if (STRING_CAPABILITIES.has(capability)) {
        this._setCapabilitySafe(capability, String(metric.value));
        continue;
      }

      const value = Number(metric.value);
      if (Number.isNaN(value)) continue;

      if (capability === 'measure_power.grid') {
        this._handleGridDirection(value);
      }

      if (ENERGY_CAPABILITIES.has(capability)) {
        this._updateEnergyCapability(capability, value);
      } else {
        this._setCapabilitySafe(capability, value);
      }
    }

    if (this._energyStateDirty) {
      this.setStoreValue('energyState', this.energyState).catch((err) => {
        this.error('Could not persist energy accumulator state:', err.message);
      });
    }
  }

  /**
   * Accumulates a lifetime total from SolarAssistant's period-to-date kWh value,
   * so Homey's Energy dashboard (which expects an ever-increasing counter) sees a
   * steadily rising number instead of periodic resets to zero.
   */
  _updateEnergyCapability(capability, rawValue) {
    let state = this.energyState[capability];

    if (!state) {
      // First reading ever for this capability: start counting from here.
      state = { last: rawValue, sum: rawValue };
    } else if (rawValue >= state.last) {
      // Normal increase within the same period.
      state.sum += (rawValue - state.last);
      state.last = rawValue;
    } else {
      // The raw value dropped, which means SolarAssistant's period counter reset
      // (daily/weekly/monthly). Add the new value as the amount collected since
      // the reset, rather than computing a (negative) delta against the old value.
      state.sum += rawValue;
      state.last = rawValue;
    }

    this.energyState[capability] = state;
    this._energyStateDirty = true;

    this._setCapabilitySafe(capability, state.sum);
  }

  _setCapabilitySafe(capability, value) {
    if (this.getCapabilityValue(capability) === value) return;
    this.setCapabilityValue(capability, value).catch((err) => {
      this.error(`Could not update ${capability}:`, err.message);
    });
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

  /** Used by Flow actions to write a setting to the inverter. */
  async sendCommand(topic, value) {
    if (!this.client) throw new Error(this.homey.__('device.connection_error'));
    return this.client.writeMetric(topic, String(value));
  }

  async onSettings({ changedKeys }) {
    if (changedKeys.includes('address') || changedKeys.includes('poll_interval')) {
      // Reconnect with the new settings once Homey has saved them.
      if (this.reconnectTimer) this.homey.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = this.homey.setTimeout(() => {
        this._connect({ force: true }).catch((err) => this.error('Reconnect failed:', err.message));
      }, 500);
    }
  }

  // --- Discovery: keeps the device's IP address up to date automatically ---
  // (see https://apps.developer.homey.app/wireless/wi-fi/discovery)
  // These callbacks must not restart a healthy connection - doing so would keep
  // tearing down the live websocket every time the discovery timestamps change.

  onDiscoveryResult(discoveryResult) {
    return discoveryResult.id === this.getData().id;
  }

  async onDiscoveryAvailable(discoveryResult) {
    if (discoveryResult.address && discoveryResult.address !== this.getSetting('address')) {
      await this.setSettings({ address: discoveryResult.address });
      await this._connect({ force: true });
      return;
    }
    // onInit() normally connects first; only connect here if that has not happened or the unit is offline.
    if (!this.client || this._unavailable) await this._connect();
  }

  onDiscoveryAddressChanged(discoveryResult) {
    this.log('SolarAssistant device found at a new address:', discoveryResult.address);
    this.setSettings({ address: discoveryResult.address })
      .then(() => this._connect({ force: true }))
      .catch((err) => this.error('Could not update address after discovery change:', err.message));
  }

  onDiscoveryLastSeenChanged() {
    // The unit was seen on the network again: reconnect only if it was considered offline.
    if (!this._unavailable) return;
    this._connect().catch((err) => this.error('Reconnect after rediscovery failed:', err.message));
  }

  async onDeleted() {
    if (this._watchdog) this.homey.clearInterval(this._watchdog);
    if (this.reconnectTimer) this.homey.clearTimeout(this.reconnectTimer);
    if (this.client) this.client.destroy();
  }

}

module.exports = SolarAssistantDevice;
