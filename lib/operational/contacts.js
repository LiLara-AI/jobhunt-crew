'use strict';

/**
 * JobHunt Crew — Local Recruiter Contact Tracker
 *
 * Keeps a small, fully local address book of people met during a search
 * (recruiters, hiring managers, peers) in `.crew/contacts.jsonl`.
 * One JSON record per line holds the latest state of each contact;
 * interactions are appended inside the contact record.
 *
 * Zero external dependencies. Nothing leaves the workspace.
 *
 * @module lib/operational/contacts
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function resolveContactsPath(options = {}) {
  if (options.filePath) return path.resolve(options.filePath);
  const workspaceDir = path.resolve(options.workspaceDir || options.workspace || process.cwd());
  return path.join(workspaceDir, '.crew', 'contacts.jsonl');
}

function slug(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24);
}

function deriveContactId(data) {
  const key = [data.email, data.name, data.company].map(v => String(v || '').trim().toLowerCase()).join('|');
  const digest = crypto.createHash('sha256').update(key).digest('hex').slice(0, 10);
  return `contact_${slug(data.name) || 'person'}_${digest}`;
}

class ContactTracker {
  constructor(options = {}) {
    this.filePath = resolveContactsPath(options);
    this.workspaceDir = path.resolve(options.workspaceDir || options.workspace || process.cwd());
  }

  _ensureDir() {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  _readAll() {
    if (!fs.existsSync(this.filePath)) return [];
    const raw = fs.readFileSync(this.filePath, 'utf8').trim();
    if (!raw) return [];
    const records = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { records.push(JSON.parse(line)); } catch (_) { /* skip malformed line */ }
    }
    return records;
  }

  _writeAll(records) {
    this._ensureDir();
    const tmp = `${this.filePath}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, records.map(r => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''), 'utf8');
    try {
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      if (process.platform === 'win32' && (err.code === 'EPERM' || err.code === 'EBUSY')) {
        fs.copyFileSync(tmp, this.filePath);
        fs.unlinkSync(tmp);
      } else {
        throw err;
      }
    }
  }

  /**
   * Adds a contact, or merges into the existing record for the same person.
   * @returns {Object} Stored contact
   */
  addContact(data = {}) {
    if (!data || typeof data !== 'object' || !String(data.name || '').trim()) {
      throw new Error('CONTACT_ERROR: A contact requires a non-empty name');
    }
    const now = new Date().toISOString();
    const id = data.id || deriveContactId(data);
    const records = this._readAll();
    const existing = records.find(r => r.id === id);

    const normalized = {
      id,
      name: String(data.name).trim(),
      role: data.role ? String(data.role) : (existing && existing.role) || '',
      persona: String(data.persona || (existing && existing.persona) || 'RECRUITER').toUpperCase(),
      company: data.company ? String(data.company) : (existing && existing.company) || '',
      email: data.email ? String(data.email) : (existing && existing.email) || '',
      profileUrl: data.profileUrl ? String(data.profileUrl) : (existing && existing.profileUrl) || '',
      jobId: data.jobId || (existing && existing.jobId) || null,
      notes: data.notes ? String(data.notes) : (existing && existing.notes) || '',
      lastContactedAt: data.lastContactedAt || (existing && existing.lastContactedAt) || null,
      nextFollowUpAt: data.nextFollowUpAt || (existing && existing.nextFollowUpAt) || null,
      interactions: existing && Array.isArray(existing.interactions) ? existing.interactions : [],
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now
    };

    if (existing) {
      Object.assign(existing, normalized);
      this._writeAll(records);
      return existing;
    }

    this._ensureDir();
    fs.appendFileSync(this.filePath, JSON.stringify(normalized) + '\n', 'utf8');
    return normalized;
  }

  listContacts(filter = {}) {
    let records = this._readAll();
    if (filter.company) {
      const wanted = String(filter.company).toLowerCase();
      records = records.filter(r => String(r.company || '').toLowerCase() === wanted);
    }
    if (filter.persona) {
      const wanted = String(filter.persona).toUpperCase();
      records = records.filter(r => String(r.persona || '').toUpperCase() === wanted);
    }
    if (filter.jobId) records = records.filter(r => r.jobId === filter.jobId);
    if (filter.dueBefore) {
      const cutoff = new Date(filter.dueBefore).getTime();
      records = records.filter(r => r.nextFollowUpAt && new Date(r.nextFollowUpAt).getTime() <= cutoff);
    }
    return records;
  }

  getContact(id) {
    return this._readAll().find(r => r.id === id) || null;
  }

  searchContacts(query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return this._readAll();
    return this._readAll().filter(r => [r.name, r.company, r.role, r.email].some(v => String(v || '').toLowerCase().includes(q)));
  }

  updateContact(id, patch = {}) {
    const records = this._readAll();
    const record = records.find(r => r.id === id);
    if (!record) throw new Error(`CONTACT_ERROR: Contact not found: ${id}`);
    const allowed = ['name', 'role', 'persona', 'company', 'email', 'profileUrl', 'jobId', 'notes', 'lastContactedAt', 'nextFollowUpAt'];
    for (const key of allowed) {
      if (patch[key] !== undefined) record[key] = key === 'persona' ? String(patch[key]).toUpperCase() : patch[key];
    }
    record.updatedAt = new Date().toISOString();
    this._writeAll(records);
    return record;
  }

  recordInteraction(id, interaction = {}) {
    const records = this._readAll();
    const record = records.find(r => r.id === id);
    if (!record) throw new Error(`CONTACT_ERROR: Contact not found: ${id}`);
    const entry = {
      at: interaction.at || new Date().toISOString(),
      channel: interaction.channel ? String(interaction.channel) : 'note',
      summary: interaction.summary ? String(interaction.summary) : ''
    };
    if (!Array.isArray(record.interactions)) record.interactions = [];
    record.interactions.push(entry);
    record.lastContactedAt = entry.at;
    if (interaction.nextFollowUpAt) record.nextFollowUpAt = interaction.nextFollowUpAt;
    record.updatedAt = new Date().toISOString();
    this._writeAll(records);
    return record;
  }

  removeContact(id) {
    const records = this._readAll();
    const kept = records.filter(r => r.id !== id);
    if (kept.length === records.length) return false;
    this._writeAll(kept);
    return true;
  }
}

module.exports = {
  ContactTracker,
  resolveContactsPath,
  deriveContactId
};
