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
  'inverter_1/device_mode': 'inverter_mode',
};

const STRING_CAPABILITIES = new Set(['inverter_mode']);

class SolarAssistantDevice extends Homey.Device {

  async onInit() {
    this.lastGridDirection = null;
    this.reconnectTimer = null;
    await this._connect();
  }

  async _connect() {
    const settings = this.getSettings();

    if (this.client) {
      this.client.destroy();
      this.client = null;
    }

    this.client = new SolarAssistantClient({
      address: settings.address,
      password: settings.password,
      token: settings.token,
      homey: this.homey,
      log: (...args) => this.log(...args),
    });

    this.client.on('metrics', (metrics) => this._handleMetrics(metrics));

    this.client.on('connected', () => {
      this.setAvailable().catch(() => {});
      // Websocket is working, so we can stop polling as frequently.
      this.client.stopPolling();
    });

    this.client.on('disconnected', () => {
      this.log('SolarAssistant websocket closed, falling back to polling');
      this.client.startPolling(settings.poll_interval || 5);
    });

    this.client.on('error', (err) => {
      this.error('SolarAssistant error:', err && err.message ? err.message : err);
    });

    try {
      await this.client.testConnection();
      await this.setAvailable();
      this.client.connectWebSocket();
      // Poll until the websocket confirms the connection (and as a safety net afterwards).
      this.client.startPolling(settings.poll_interval || 5);
    } catch (err) {
      this.error('Could not connect to SolarAssistant:', err.message);
      await this.setUnavailable(this.homey.__('device.connection_error')).catch(() => {});
      // Keep retrying periodically even if the first attempt failed.
      this.client.startPolling(settings.poll_interval || 5);
    }
  }

  _handleMetrics(metrics) {
    if (!Array.isArray(metrics)) return;
    this.setAvailable().catch(() => {});

    for (const metric of metrics) {
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

      this._setCapabilitySafe(capability, value);
    }
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

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes('address') || changedKeys.includes('password') || changedKeys.includes('poll_interval')) {
      // Reconnect with the new settings once Homey has saved them.
      if (this.reconnectTimer) this.homey.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = this.homey.setTimeout(() => this._connect(), 500);
    }
  }

  async onDeleted() {
    if (this.reconnectTimer) this.homey.clearTimeout(this.reconnectTimer);
    if (this.client) this.client.destroy();
  }

}

module.exports = SolarAssistantDevice;
