'use strict';

const Homey = require('homey');
const SolarAssistantClient = require('./solarAssistantClient');

/**
 * Base class for every SolarAssistant driver (overview, solar, battery, grid).
 *
 * Pairing works in two ways:
 *  - Log in: enter the unit's IP address (or leave it blank to look for it on the
 *    network) and the unit's local password.
 *  - Reuse a known unit: drivers whose pair list starts with a "loading" view
 *    (pairShortcut) skip the login when the user already has a SolarAssistant
 *    device, and offer that unit straight away.
 */
class UnitDriver extends Homey.Driver {

  /** Locale key (under "devicename") for the default name of devices from this driver. */
  get deviceNameKey() {
    return 'overview';
  }

  /** True when the driver's pair list starts with a "loading" view that routes the user. */
  get pairShortcut() {
    return false;
  }

  /** Pairing/repair message that says what went wrong, based on the error from testConnection(). */
  _loginErrorMessage(err) {
    switch (err && err.reason) {
      case 'auth': return this.homey.__('pair.password_rejected');
      case 'unreachable': return this.homey.__('pair.unreachable');
      case 'unexpected': return this.homey.__('pair.unexpected_response');
      default: return this.homey.__('pair.connection_failed');
    }
  }

  /** Check the address and password. Throws an error with a message fit for the user. */
  async _verifyLogin(address, password, context) {
    const client = new SolarAssistantClient({
      address,
      password,
      homey: this.homey,
      log: this.log.bind(this),
    });

    try {
      await client.testConnection();
    } catch (err) {
      this.error(`${context} failed:`, err.message);
      throw new Error(this._loginErrorMessage(err));
    } finally {
      client.destroy();
    }
  }

  /** The device object handed to Homey's list_devices view. The password goes in the store, not in settings. */
  _buildDevice({ address, password, id }) {
    return {
      name: `${this.homey.__(`devicename.${this.deviceNameKey}`)} (${address})`,
      data: { id },
      settings: { address, poll_interval: 5 },
      store: { password },
    };
  }

  /** Units the user already has that this driver has not been added for yet. */
  _shortcutDevices() {
    const alreadyAdded = new Set(this.getDevices().map((device) => device.getData().id));
    return this.homey.app.knownUnits()
      .filter((unit) => !alreadyAdded.has(unit.id))
      .map((unit) => this._buildDevice(unit));
  }

  async onPair(session) {
    // Devices confirmed to be a real SolarAssistant unit through the login in this session.
    let foundDevices = [];
    // Devices offered from units the user already has (no login needed).
    let shortcutDevices = [];
    let routed = false;

    if (this.pairShortcut) {
      // The pair list is [loading, login_credentials, list_devices, add_devices], so
      // nextView() from "loading" leads to the login. Skipping ahead to the device list
      // is the only case that needs showView().
      session.setHandler('showView', async (view) => {
        if (view !== 'loading') return;

        try {
          // Only the first visit is routed to the shortcut. Coming back with the
          // back button leads to the login, so the user can add another unit.
          if (!routed) {
            routed = true;
            shortcutDevices = this._shortcutDevices();
            if (shortcutDevices.length > 0) {
              await session.showView('list_devices');
              return;
            }
          }
        } catch (err) {
          this.error('Could not offer the existing SolarAssistant unit:', err.message);
        }

        await session.nextView();
      });
    }

    session.setHandler('login', async (data) => {
      const manualAddress = String(data.username || '').trim();
      const password = data.password || '';
      foundDevices = [];

      if (manualAddress) {
        // Manual override: the user filled in an IP address themselves.
        await this._verifyLogin(manualAddress, password, 'Manual login');

        // If discovery knows this address, use its MAC address as id, so the device can
        // follow the unit when it gets a new IP address. Otherwise fall back to the address.
        const known = this.homey.app.discoveryResults()
          .find((result) => result.address && result.address.trim().toLowerCase() === manualAddress.toLowerCase());

        foundDevices.push(this._buildDevice({
          address: manualAddress,
          password,
          id: known ? known.id : (manualAddress.replace(/[^a-zA-Z0-9]/g, '_') || `site_${Date.now()}`),
        }));
        return true;
      }

      // Auto-detect: test every discovered Raspberry Pi / Orange Pi on the network with the given password.
      const discoveryResults = this.homey.app.discoveryResults();
      let passwordRejected = false;

      for (const result of discoveryResults) {
        const client = new SolarAssistantClient({
          address: result.address,
          password,
          homey: this.homey,
          log: this.log.bind(this),
        });

        try {
          await client.testConnection();
          foundDevices.push(this._buildDevice({ address: result.address, password, id: result.id }));
        } catch (err) {
          // Not a SolarAssistant device, or the password did not match - skip it.
          if (err && err.reason === 'auth') passwordRejected = true;
        } finally {
          client.destroy();
        }
      }

      if (foundDevices.length === 0) {
        // A device that answers but rejects the password is a different problem from finding nothing.
        throw new Error(this.homey.__(passwordRejected ? 'pair.found_but_rejected' : 'pair.no_devices_found'));
      }

      return true;
    });

    session.setHandler('list_devices', async () => (foundDevices.length > 0 ? foundDevices : shortcutDevices));
  }

  async onRepair(session, device) {
    session.setHandler('login', async (data) => {
      const address = String(data.username || '').trim();
      const password = data.password || '';

      if (!address) {
        throw new Error(this.homey.__('pair.missing_address'));
      }

      await this._verifyLogin(address, password, 'Login during repair');

      const oldAddress = String(device.getSetting('address') || '').trim();

      await device.setStoreValue('password', password);
      await device.setSettings({ address });

      // setSettings() does not trigger onSettings(), so reconnect explicitly, and bring
      // the other devices on the same unit along.
      device.attachToUnit();
      await this.homey.app.syncUnit(device, oldAddress, { address, password });

      return true;
    });
  }

}

module.exports = UnitDriver;
