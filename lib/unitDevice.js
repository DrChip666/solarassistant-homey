'use strict';

const Homey = require('homey');
const EnergyAccumulator = require('./energyAccumulator');

// The device is marked unavailable when neither a live message nor a REST response
// has arrived for this long (e.g. power cut, network problem, unit rebooting).
const STALE_AFTER_MS = 2 * 60 * 1000;
const WATCHDOG_INTERVAL_MS = 15 * 1000;

/** SolarAssistant sends on/off values as true/false, or as words like "Enabled". */
function toBoolean(value) {
  if (typeof value === 'string') return ['true', 'enabled', 'on', 'yes', '1'].includes(value.trim().toLowerCase());
  return Boolean(value);
}

/**
 * Base class for every SolarAssistant device (overview, solar, battery, grid).
 *
 * It attaches the device to the shared connection for its unit and keeps the
 * device's availability up to date. Subclasses only describe which SolarAssistant
 * topics end up in which capabilities (topicMap), or override handleMetrics().
 */
class UnitDevice extends Homey.Device {

  /**
   * Which topic feeds which capability:
   *   { [topic]: { capability, energy?, string?, transform? } }
   *   energy    the raw value is a period-to-date kWh figure, accumulated into a lifetime total
   *   string    the value is text rather than a number
   *   boolean   the value is an on/off state
   *   transform adjusts a numeric value before it is stored
   */
  get topicMap() {
    return {};
  }

  async onInit() {
    // Homey remembers availability across restarts, so start from the real state.
    this._unavailable = !this.getAvailable();
    this._lastDataAt = Date.now();
    // { [capability]: { last, sum } }, persisted across restarts.
    this.energy = new EnergyAccumulator(this.getStoreValue('energyState'));

    await this.onUnitInit();

    this._watchdog = this.homey.setInterval(() => this._checkFreshness(), WATCHDOG_INTERVAL_MS);
    this.attachToUnit();
  }

  /** Hook for subclasses that need state before the first values arrive. */
  async onUnitInit() {}

  // --- Connection ----------------------------------------------------------

  /** The id of the SolarAssistant unit this device belongs to (its MAC address when found by discovery). */
  getUnitId() {
    const data = this.getData();
    return data.unitId || data.id;
  }

  /** Single topics (beyond the totals) this device needs live. Devices that show one value override this. */
  getTopics() {
    return [];
  }

  _unitConfig(settings = this.getSettings()) {
    return {
      address: String(settings.address || '').trim(),
      password: this.getStoreValue('password'),
      pollSeconds: settings.poll_interval || 5,
      preferredWsPath: this.getStoreValue('wsPath'),
      topics: this.getTopics(),
    };
  }

  /**
   * Attach to the unit, or re-apply the current settings if already attached.
   * Safe to call repeatedly: unchanged settings do nothing.
   * @param {object} [settings] Use these settings instead of the stored ones (e.g. from onSettings).
   */
  attachToUnit(settings) {
    const config = this._unitConfig(settings);

    if (!config.address) {
      this.error('No address is set for this device');
      this._markUnavailable();
      return;
    }

    if (this.lease) {
      this.lease.update(config);
      return;
    }

    this.lease = this.homey.app.connections.acquire(config, {
      onMetrics: (metrics) => this._onMetrics(metrics),
      onAlive: () => this._markAlive(),
      onUnreachable: (err) => {
        this.error('Could not connect to SolarAssistant:', err && err.message ? err.message : err);
        this._markUnavailable();
        this._unitMayHaveMoved();
      },
      onWsPath: (path) => {
        // Remember which websocket path this unit's firmware uses.
        this.setStoreValue('wsPath', path).catch((err) => {
          this.error('Could not store websocket path:', err.message);
        });
      },
    });
  }

  /** Used by Flow actions to write a setting to the inverter. */
  async sendCommand(topic, value) {
    if (!this.lease) throw new Error(this.homey.__('device.connection_error'));
    return this.lease.writeMetric(topic, String(value));
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
      this._unitMayHaveMoved();
    }
  }

  /** The unit might have received a new IP address: ask the app to look at the discovery results. */
  _unitMayHaveMoved() {
    try {
      this.homey.app.checkDiscovery().catch((err) => this.error('Discovery check failed:', err.message));
    } catch (err) {
      this.error('Discovery check failed:', err.message);
    }
  }

  // --- Incoming values -----------------------------------------------------

  _onMetrics(metrics) {
    if (!Array.isArray(metrics)) return;
    this.handleMetrics(metrics);
    this._persistEnergy();
  }

  /** Default behaviour: apply topicMap. Subclasses with extra logic override this. */
  handleMetrics(metrics) {
    this.applyTopicMap(metrics);
  }

  applyTopicMap(metrics) {
    const map = this.topicMap;

    for (const metric of metrics) {
      if (!metric || metric.value === null || metric.value === undefined) continue;

      const entry = map[metric.topic];
      if (!entry || !this.hasCapability(entry.capability)) continue;

      if (entry.string) {
        this._setCapabilitySafe(entry.capability, String(metric.value));
        continue;
      }

      if (entry.boolean) {
        this._setCapabilitySafe(entry.capability, toBoolean(metric.value));
        continue;
      }

      let value = Number(metric.value);
      if (Number.isNaN(value)) continue;
      if (entry.transform) value = entry.transform(value);

      if (entry.energy) this._updateEnergy(entry.capability, value);
      else this._setCapabilitySafe(entry.capability, value);
    }
  }

  /**
   * SolarAssistant's kWh values restart from zero every day/week/month, but Homey
   * Energy expects an ever-increasing total, so accumulate our own.
   */
  _updateEnergy(capability, rawValue) {
    this._setCapabilitySafe(capability, this.energy.update(capability, rawValue));
  }

  _persistEnergy() {
    if (!this.energy.dirty) return;
    this.energy.dirty = false;
    this.setStoreValue('energyState', this.energy.state).catch((err) => {
      this.error('Could not persist energy accumulator state:', err.message);
    });
  }

  _setCapabilitySafe(capability, value) {
    if (this.getCapabilityValue(capability) === value) return;
    this.setCapabilityValue(capability, value).catch((err) => {
      this.error(`Could not update ${capability}:`, err.message);
    });
  }

  // --- Settings ------------------------------------------------------------

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    if (!changedKeys.includes('address') && !changedKeys.includes('poll_interval')) return;

    const address = String(newSettings.address || '').trim();
    if (!address) throw new Error(this.homey.__('pair.missing_address'));

    this.attachToUnit(newSettings);

    // Every device on the same unit follows the new address.
    if (changedKeys.includes('address')) {
      await this.homey.app.syncUnit(this, String(oldSettings.address || '').trim(), { address });
    }
  }

  // --- IP address changes found through discovery ----------------------------
  // (the app calls this, see App#checkDiscovery)

  /** The unit has been seen at another IP address: use it, and bring the other devices on the unit along. */
  async followAddress(address) {
    const oldAddress = String(this.getSetting('address') || '').trim();
    if (!address || address.trim().toLowerCase() === oldAddress.toLowerCase()) return;

    this.log('SolarAssistant unit found at a new address:', address);

    // setSettings() does not trigger onSettings(), so apply the change ourselves.
    await this.setSettings({ address });
    this.attachToUnit();
    await this.homey.app.syncUnit(this, oldAddress, { address });
  }

  async onDeleted() {
    if (this._watchdog) this.homey.clearInterval(this._watchdog);
    if (this.lease) {
      this.lease.release();
      this.lease = null;
    }
  }

}

module.exports = UnitDevice;
