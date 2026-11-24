/**
 * Settings Store
 * Persistensi atomik untuk pengaturan layanan global (data/settings.json).
 */

const fs = require('fs');
const path = require('path');
const { atomicWriteJsonSync, readJsonSafeSync } = require('./utils/atomicFile');

class SettingsStore {
  constructor(options = {}) {
    this.dataPath = options.dataPath || path.resolve(__dirname, '../data');
    this.settingsFile = path.join(this.dataPath, 'settings.json');
    this.state = {
      serviceEnabled: true,
      whitelistOnly: process.env.WHITELIST_ONLY === 'true',
      replyGroups: process.env.REPLY_GROUPS === 'true'
    };
    this.load();
  }

  load() {
    if (!fs.existsSync(this.settingsFile)) {
      const exampleFile = path.join(this.dataPath, 'settings.example.json');
      if (fs.existsSync(exampleFile)) {
        try { fs.copyFileSync(exampleFile, this.settingsFile); } catch {}
      }
    }
    const res = readJsonSafeSync(this.settingsFile);
    if (res.ok && res.data && typeof res.data === 'object') {
      if (typeof res.data.serviceEnabled === 'boolean') this.state.serviceEnabled = res.data.serviceEnabled;
      if (typeof res.data.whitelistOnly === 'boolean') this.state.whitelistOnly = res.data.whitelistOnly;
      if (typeof res.data.replyGroups === 'boolean') this.state.replyGroups = res.data.replyGroups;
    } else if (!res.missing && res.error) {
      console.warn('[Settings] Gagal memuat settings.json:', res.error.message);
    }
  }

  save() {
    try {
      atomicWriteJsonSync(this.settingsFile, {
        serviceEnabled: this.state.serviceEnabled,
        whitelistOnly: this.state.whitelistOnly,
        replyGroups: this.state.replyGroups,
        updatedAt: new Date().toISOString()
      });
    } catch (err) {
      console.error('[Settings] Gagal menyimpan settings.json:', err.message);
    }
  }

  getAll() {
    return { ...this.state };
  }

  toggleService() {
    this.state.serviceEnabled = !this.state.serviceEnabled;
    this.save();
    return this.state.serviceEnabled;
  }

  toggleWhitelist() {
    this.state.whitelistOnly = !this.state.whitelistOnly;
    this.save();
    return this.state.whitelistOnly;
  }

  toggleGroups() {
    this.state.replyGroups = !this.state.replyGroups;
    this.save();
    return this.state.replyGroups;
  }
}

module.exports = SettingsStore;
