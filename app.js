'use strict';

const Homey = require('homey');
const ConnectionManager = require('./lib/connectionManager');

const sameAddress = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

// The discovery strategy defined in app.json (Raspberry Pi / Orange Pi MAC addresses).
// It is used on its own, NOT linked to the drivers: a driver-linked strategy makes Homey
// manage the devices' availability itself, and a device that was added with a typed IP
// address (or whose MAC is not matched) would then be marked unavailable for good.
const DISCOVERY_STRATEGY = 'solarassistant_sbc';
const DISCOVERY_CHECK_MS = 60 * 1000;
const DISCOVERY_MIN_GAP_MS = 5 * 1000;

class SolarAssistantApp extends Homey.App {

  async onInit() {
    // One connection per SolarAssistant unit, shared by all devices that belong to it.
    this.connections = new ConnectionManager({
      homey: this.homey,
      log: (...args) => this.log(...args),
      error: (...args) => this.error(...args),
    });

    // Start looking for SolarAssistant units on the network right away, so the results
    // are there when the user pairs a device.
    try {
      this._strategy = this.homey.discovery.getStrategy(DISCOVERY_STRATEGY);
      this._strategy.on('result', () => this._checkDiscoverySoon());
    } catch (err) {
      this.error('Could not start discovery:', err.message);
    }

    // A unit that gets a new IP address (DHCP) is found again by its MAC address.
    this._discoveryTimer = this.homey.setInterval(() => this._checkDiscoverySoon(), DISCOVERY_CHECK_MS);

    this.log('SolarAssistant app has started');
  }

  async onUninit() {
    if (this._discoveryTimer) this.homey.clearInterval(this._discoveryTimer);
    if (this.connections) this.connections.destroy();
  }

  /** What discovery has found on the network so far. */
  discoveryResults() {
    try {
      return this._strategy ? Object.values(this._strategy.getDiscoveryResults()) : [];
    } catch (err) {
      this.error('Could not read discovery results:', err.message);
      return [];
    }
  }

  _checkDiscoverySoon() {
    this.checkDiscovery().catch((err) => this.error('Discovery check failed:', err.message));
  }

  /**
   * Devices that were added through discovery keep the MAC address of their unit as id.
   * When discovery sees that MAC at another IP address, the devices follow it.
   * (Devices added with a typed IP address have no MAC to follow and are left alone.)
   */
  async checkDiscovery() {
    const now = Date.now();
    if (this._lastDiscoveryCheck && now - this._lastDiscoveryCheck < DISCOVERY_MIN_GAP_MS) return;
    this._lastDiscoveryCheck = now;

    const results = this.discoveryResults();
    if (results.length === 0) return;

    for (const device of this.unitDevices()) {
      const result = results.find((r) => r.id === device.getData().id);
      if (!result || !result.address) continue;
      try {
        await device.followAddress(result.address);
      } catch (err) {
        this.error('Could not follow the new address of a SolarAssistant unit:', err.message);
      }
    }
  }

  /** Every SolarAssistant device, whichever driver it belongs to. */
  unitDevices() {
    const devices = [];
    for (const driver of Object.values(this.homey.drivers.getDrivers())) {
      for (const device of driver.getDevices()) devices.push(device);
    }
    return devices;
  }

  /** The units the user already has, read from the paired devices. One entry per address. */
  knownUnits() {
    const units = new Map();
    for (const device of this.unitDevices()) {
      const address = String(device.getSetting('address') || '').trim();
      if (!address || units.has(address.toLowerCase())) continue;
      units.set(address.toLowerCase(), {
        address,
        password: device.getStoreValue('password'),
        id: device.getData().id,
      });
    }
    return [...units.values()];
  }

  /**
   * Several devices can belong to the same unit. When the address or password of one
   * changes, the others on that unit follow, so the user only has to change it once.
   *
   * @param {Homey.Device} source  The device that was changed (left alone).
   * @param {string} oldAddress    The address the unit had before the change.
   * @param {{address?: string, password?: string}} changes
   */
  async syncUnit(source, oldAddress, changes) {
    for (const device of this.unitDevices()) {
      if (device === source) continue;
      if (!sameAddress(device.getSetting('address'), oldAddress)) continue;

      try {
        if (changes.address) await device.setSettings({ address: changes.address });
        if (changes.password !== undefined) await device.setStoreValue('password', changes.password);
        device.attachToUnit();
      } catch (err) {
        this.error('Could not update a device on the same SolarAssistant unit:', err.message);
      }
    }
  }

}

module.exports = SolarAssistantApp;
