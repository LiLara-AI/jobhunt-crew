'use strict';

/**
 * JobHunt Crew — CLI Contact Commands
 *
 * Local recruiter contact book over ContactTracker (.crew/contacts.jsonl).
 *
 * @module lib/cli/commands/contact
 */

const { ContactTracker } = require('../../operational/contacts');
const { parseArgs, resolveWorkspace } = require('../shared');

async function runContact(subcommand, rawArgs = []) {
  const { flags, positional } = parseArgs(rawArgs);
  const targetDir = resolveWorkspace(flags);
  const tracker = new ContactTracker({ workspaceDir: targetDir });

  if (subcommand === 'add') {
    const name = flags.name || positional[0];
    if (!name || name === true) {
      console.error('[ERROR] Missing required flag: --name <name> [--company <c>] [--persona <p>] [--role <r>] [--email <e>] [--linkedin <url>] [--job-id <id>] [--notes <text>]');
      return 1;
    }
    try {
      const role = flags.role || '';
      const persona = flags.persona || (['RECRUITER', 'HIRING_MANAGER', 'PEER'].includes(String(role).toUpperCase()) ? String(role).toUpperCase() : undefined);
      const contact = tracker.addContact({
        id: flags.id && flags.id !== true ? flags.id : undefined,
        name,
        company: flags.company || '',
        persona,
        role,
        email: flags.email || '',
        profileUrl: flags.linkedin || flags['profile-url'] || flags.profileUrl || flags.url || '',
        jobId: flags['job-id'] || flags.jobId || null,
        notes: flags.notes || '',
        lastContactedAt: flags['last-contacted'] || flags.lastContactedAt || undefined,
        nextFollowUpAt: flags['next-follow-up'] || flags.nextFollowUpAt || undefined
      });
      if (flags.json) console.log(JSON.stringify(contact, null, 2));
      else console.log(`[CONTACT] Added: ${contact.id} ${contact.name}${contact.company ? ' @ ' + contact.company : ''}`);
      return 0;
    } catch (err) {
      console.error(`[ERROR] ${err.message}`);
      return 1;
    }
  }

  if (subcommand === 'list') {
    try {
      const filter = {};
      if (flags.company) filter.company = flags.company;
      if (flags.persona) filter.persona = flags.persona;
      if (flags['job-id'] || flags.jobId) filter.jobId = flags['job-id'] || flags.jobId;
      const contacts = tracker.listContacts(filter);
      if (flags.json) {
        console.log(JSON.stringify(contacts, null, 2));
      } else {
        console.log(`[CONTACTS] ${contacts.length} contact(s):`);
        for (const c of contacts) console.log(`  - ${c.id} ${c.name}${c.company ? ' @ ' + c.company : ''} [${c.persona || ''}]`);
      }
      return 0;
    } catch (err) {
      console.error(`[ERROR] ${err.message}`);
      return 1;
    }
  }

  if (subcommand === 'get') {
    const key = flags.id || flags.name || positional[0];
    if (!key || key === true) {
      console.error('[ERROR] Missing required input: --id <id> or --name <name> or <id>');
      return 1;
    }
    try {
      let contact = tracker.getContact(key);
      if (!contact) {
        const hits = tracker.searchContacts(key);
        contact = hits.find(c => String(c.name || '').toLowerCase() === String(key).toLowerCase()) || hits[0] || null;
      }
      if (!contact) {
        console.error(`[ERROR] Contact not found: ${key}`);
        return 1;
      }
      if (flags.json) console.log(JSON.stringify(contact, null, 2));
      else {
        console.log(`[CONTACT] ${contact.id} ${contact.name}${contact.company ? ' @ ' + contact.company : ''}`);
        if (contact.email) console.log(`  Email: ${contact.email}`);
        if (contact.profileUrl) console.log(`  Profile: ${contact.profileUrl}`);
        if (contact.role) console.log(`  Role: ${contact.role}`);
        if (contact.notes) console.log(`  Notes: ${contact.notes}`);
      }
      return 0;
    } catch (err) {
      console.error(`[ERROR] ${err.message}`);
      return 1;
    }
  }

  console.error(`[ERROR] Unknown contact subcommand: ${subcommand}. Usage: crew contact <add|list|get> [options]`);
  return 1;
}

module.exports = { runContact };
