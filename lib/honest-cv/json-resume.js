'use strict';

/**
 * JobHunt Crew — JSON Resume v1.0.0 interchange.
 * Bidirectional mapping between CareerDossier data and JSON Resume.
 * Zero external dependencies.
 * Ref: https://github.com/jsonresume/resume-schema (v1.0.0)
 */

const { CareerDossier } = require('./dossier');

function yearToDate(year, isEnd) {
  if (!year) return undefined;
  return isEnd ? `${year}-12-31` : `${year}-01-01`;
}

function dateToYear(dateStr, fallback = 2020) {
  const m = String(dateStr || '').match(/\b(\d{4})\b/);
  return m ? parseInt(m[1], 10) : fallback;
}

function plainDossier(dossier) {
  if (dossier instanceof CareerDossier) return JSON.parse(dossier.toJson(false));
  return dossier || {};
}

/** Exports dossier data as a JSON Resume v1.0.0 document. */
function dossierToJsonResume(dossier) {
  const d = plainDossier(dossier);
  const c = d.candidate || {};
  const resume = {
    $schema: 'https://raw.githubusercontent.com/jsonresume/resume-schema/v1.0.0/schema.json',
    basics: {
      name: c.name || '',
      label: c.currentTitle || '',
      email: c.email || '',
      phone: c.phone || '',
      summary: c.summary || '',
      location: { address: c.location || '' },
      profiles: []
    },
    work: (d.employers || []).map(emp => ({
      name: emp.name || '',
      position: emp.title || '',
      location: emp.location || '',
      startDate: yearToDate(emp.startYear, false),
      ...(emp.isCurrent || !emp.endYear ? {} : { endDate: yearToDate(emp.endYear, true) }),
      highlights: (d.claims || []).filter(cl => cl.employerId === emp.id).map(cl => cl.text)
    })),
    education: (d.degrees || []).map(deg => ({
      institution: deg.institution || '',
      studyType: deg.degree || '',
      area: deg.thesis || '',
      startDate: yearToDate(deg.year, false),
      endDate: yearToDate(deg.year, true)
    })),
    skills: [],
    certificates: (d.certifications || []).map(cert => ({
      name: cert.name || '',
      issuer: cert.issuer || '',
      date: yearToDate(cert.year, false)
    })),
    meta: { version: 'v1.0.0', lastModified: d.updatedAt || new Date().toISOString() }
  };
  const skillGroups = [
    ['languages', 'Languages'], ['frameworks', 'Frameworks'],
    ['infrastructure', 'Infrastructure'], ['databases', 'Databases'],
    ['architecturalDomains', 'Architectural Domains']
  ];
  for (const [key, label] of skillGroups) {
    const items = (d.skills || {})[key] || [];
    if (items.length) resume.skills.push({ name: label, keywords: [...items] });
  }
  return resume;
}

/** Imports a JSON Resume v1.0.0 document as raw CareerDossier data. */
function jsonResumeToDossierData(resume) {
  const r = typeof resume === 'string' ? JSON.parse(resume) : (resume || {});
  const basics = r.basics || {};
  const employers = [];
  const claims = [];
  let claimSeq = 0;
  (r.work || []).forEach((job, i) => {
    const isCurrent = !job.endDate;
    const emp = {
      id: `emp_${String(i + 1).padStart(2, '0')}`,
      name: job.name || job.company || '',
      location: job.location || '',
      startYear: dateToYear(job.startDate, 2020),
      endYear: isCurrent ? null : dateToYear(job.endDate, 2020),
      isCurrent,
      title: job.position || ''
    };
    employers.push(emp);
    const highlights = Array.isArray(job.highlights) ? job.highlights : [];
    for (const h of highlights) {
      claimSeq++;
      claims.push({
        id: `C-${String(claimSeq).padStart(2, '0')}`,
        employerId: emp.id, category: 'experience', text: String(h),
        metrics: [], tools: [], role: emp.title, status: 'CONFIRM',
        clarificationPrompt: 'Imported from JSON Resume — please confirm this accomplishment'
      });
    }
    if (job.summary) {
      claimSeq++;
      claims.push({
        id: `C-${String(claimSeq).padStart(2, '0')}`,
        employerId: emp.id, category: 'experience', text: String(job.summary),
        metrics: [], tools: [], role: emp.title, status: 'CONFIRM',
        clarificationPrompt: 'Imported from JSON Resume — please confirm this accomplishment'
      });
    }
  });
  const skills = { languages: [], frameworks: [], infrastructure: [], databases: [], architecturalDomains: [] };
  const bucketFor = (name) => {
    const n = String(name || '').toLowerCase();
    if (/framework|librar|platform/.test(n)) return 'frameworks';
    if (/infra|cloud|devops|tool|web/.test(n)) return 'infrastructure';
    if (/data|db|sql/.test(n)) return 'databases';
    if (/architect|domain|method|soft/.test(n)) return 'architecturalDomains';
    return 'languages';
  };
  for (const group of r.skills || []) {
    const bucket = bucketFor(group.name);
    for (const kw of group.keywords || []) skills[bucket].push(String(kw));
  }
  const loc = basics.location || {};
  const locationStr = [loc.city, loc.region, loc.countryCode].filter(Boolean).join(', ') || loc.address || '';
  return {
    schemaVersion: '1.0.0',
    candidate: {
      name: basics.name || '',
      email: basics.email || '',
      phone: basics.phone || '',
      location: locationStr,
      currentTitle: basics.label || (employers[0] ? employers[0].title : ''),
      summary: basics.summary || ''
    },
    employers,
    claims,
    degrees: (r.education || []).map(ed => ({
      degree: ed.studyType || '',
      institution: ed.institution || '',
      year: dateToYear(ed.endDate || ed.startDate, 2020),
      ...(ed.area ? { thesis: ed.area } : {})
    })),
    certifications: (r.certificates || []).map(cert => ({
      name: cert.name || '', issuer: cert.issuer || '', year: dateToYear(cert.date, 2020)
    })),
    skills
  };
}

/** Imports JSON Resume directly as a validated CareerDossier. */
function jsonResumeToDossier(resume) {
  return new CareerDossier(jsonResumeToDossierData(resume));
}

module.exports = { dossierToJsonResume, jsonResumeToDossierData, jsonResumeToDossier };
