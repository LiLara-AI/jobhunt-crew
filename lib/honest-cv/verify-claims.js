#!/usr/bin/env node
'use strict';

/**
 * JobHunt Crew — Deterministic Claim Verifier Engine
 *
 * Standalone executable CLI and library module for AST/NLP entity extraction
 * and claim verification against structured candidate dossiers.
 *
 * Zero external dependencies. Uses Node.js standard runtime.
 */

const fs = require('fs');
const path = require('path');

const VIOLATION_CODES = {
  METRIC_INFLATION: 'METRIC_INFLATION',
  UNSUPPORTED_TOOL: 'UNSUPPORTED_TOOL',
  UNVERIFIED_TECHNOLOGY: 'UNVERIFIED_TECHNOLOGY',
  TRANSPLANTED_EMPLOYER: 'TRANSPLANTED_EMPLOYER',
  AUTHORSHIP_INFLATION: 'AUTHORSHIP_INFLATION',
  SCOPE_INFLATION: 'SCOPE_INFLATION',
  ROLE_INFLATION: 'ROLE_INFLATION',
  TITLE_INFLATION: 'TITLE_INFLATION',
  UNTAGGED_METRIC: 'UNTAGGED_METRIC',
  FABRICATED_CREDENTIAL: 'FABRICATED_CREDENTIAL',
  FABRICATED_DEGREE: 'FABRICATED_DEGREE',
  FABRICATED_PATENT: 'FABRICATED_PATENT',
  FABRICATED_AWARD: 'FABRICATED_AWARD',
  FABRICATED_ENDORSEMENT: 'FABRICATED_ENDORSEMENT',
  TIMELINE_DISCREPANCY: 'TIMELINE_DISCREPANCY',
  UNVERIFIED_CLAIM: 'UNVERIFIED_CLAIM',
  UNKNOWN_EMPLOYER: 'UNKNOWN_EMPLOYER',
  UNVERIFIED_EMPLOYER: 'UNVERIFIED_EMPLOYER'
};

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const SENTENCE_ABBREVIATIONS = [
  'e.g', 'i.e', 'etc', 'vs', 'approx', 'Dr', 'Mr', 'Mrs', 'Ms', 'Prof', 'Sr', 'Jr',
  'St', 'No', 'Fig', 'Dept', 'Inc', 'Ltd', 'Co', 'Corp', 'U.S', 'U.K', 'U.S.A',
  'Ph.D', 'M.Sc', 'B.Sc', 'M.A', 'B.A', 'Jan', 'Feb', 'Mar', 'Apr', 'Jun', 'Jul',
  'Aug', 'Sep', 'Sept', 'Oct', 'Nov', 'Dec', 'al', 'ca', 'cf', 'viz'
];

/**
 * Splits text into sentences without breaking on decimals (1.5M, v2.0),
 * abbreviations (e.g., Dr., vs.), initials (J. R.), or ellipses.
 */
function splitSentences(text) {
  if (!text || typeof text !== 'string') return [];
  const DOT = '\u0001';
  let s = text;
  // Decimals and versions: digit.digit, v2.0.1, 1.5M
  s = s.replace(/(\d)\.(\d)/g, `$1${DOT}$2`);
  s = s.replace(/([A-Za-z])\.(\d)/g, `$1${DOT}$2`);
  // Ellipsis
  s = s.replace(/\.\.\./g, `${DOT}${DOT}${DOT}`);
  // Known abbreviations (protect every dot inside them)
  for (const abbr of SENTENCE_ABBREVIATIONS) {
    const pattern = abbr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\./g, '\\.');
    s = s.replace(new RegExp(`\\b${pattern}\\.`, 'gi'), (m) => m.replace(/\./g, DOT));
  }
  // Single-letter initials: "J. R. Smith"
  s = s.replace(/\b([A-Z])\.(?=\s)/g, `$1${DOT}`);
  // Domain-like tokens: example.org, Node.js
  s = s.replace(/([A-Za-z0-9])\.([A-Za-z])/g, `$1${DOT}$2`);
  const parts = s.split(/(?<=[.?!])\s+(?=["'(\[]?[A-Z0-9\u0600-\u06FF])/);
  return parts.map(p => p.split(DOT).join('.').trim()).filter(Boolean);
}

/**
 * Builds a flexible matcher for a phrase: hyphen/space variants, optional
 * trailing plural, and number-word/digit variants for experience phrases.
 */
function phraseToRegExp(phrase) {
  const words = String(phrase).toLowerCase().split(/[\s-]+/).filter(Boolean);
  if (words.length === 0) return null;
  const body = words.map(w => escapeRegExp(w)).join('[\\s-]+');
  try { return new RegExp(`\\b${body}s?\\b`, 'i'); } catch (_) { return null; }
}

const PHRASE_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'for', 'with', 'by', 'on', 'in', 'at',
  'from', 'that', 'this', 'was', 'were', 'are', 'is', 'into', 'across', 'through',
  'using', 'used', 'via', 'per', 'while', 'led', 'built', 'developed', 'designed',
  'improved', 'reduced', 'increased', 'delivered', 'worked', 'responsible', 'team',
  'teams', 'engineers', 'engineering', 'system', 'systems', 'platform', 'service',
  'services', 'new', 'core', 'senior', 'staff', 'principal'
]);

/**
 * Extracts distinctive phrases from a claim: tools, hyphenated compounds,
 * quantified experience ("8+ years", "Over 8 years"), and content n-grams.
 */
function extractClaimPhrases(claim) {
  const phrases = new Set();
  const text = String((claim && claim.text) || '');
  for (const tool of (claim && claim.tools) || []) {
    if (tool && tool.trim().length >= 3) phrases.add(tool.trim().toLowerCase());
  }
  // Hyphenated compounds e.g. two-phase commit
  for (const m of text.matchAll(/\b[A-Za-z]+(?:-[A-Za-z]+)+(?:\s+[A-Za-z]+)?/g)) {
    phrases.add(m[0].toLowerCase());
  }
  // Quantified experience: digits/words, optional +, optional "Over"
  for (const m of text.matchAll(/\b(?:over\s+|more than\s+)?(\d+|[a-z]+)\s*\+?\s*years?\b/gi)) {
    phrases.add(m[0].toLowerCase().replace(/\s+/g, ' '));
    phrases.add(`${m[1].toLowerCase()} years`);
  }
  // Content bigrams/trigrams
  const tokens = text.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/)
    .filter(w => w.length > 2 && !PHRASE_STOPWORDS.has(w));
  for (let n = 2; n <= 3; n++) {
    for (let i = 0; i + n <= tokens.length; i++) {
      phrases.add(tokens.slice(i, i + n).join(' '));
    }
  }
  return [...phrases];
}

const NUMBER_WORDS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90
};

function parseNumberWordPhrase(phrase) {
  const clean = phrase.toLowerCase().replace(/[-\s]+/g, ' ').trim();
  const tokens = clean.split(' ').filter(Boolean);
  if (tokens.length === 0) return null;

  let total = 0;
  let current = 0;
  let hasNumber = false;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === 'and') continue;

    if (token === 'point' && i + 1 < tokens.length) {
      const next = tokens[++i];
      const dec = NUMBER_WORDS[next] !== undefined ? NUMBER_WORDS[next] : parseFloat(next);
      if (!isNaN(dec)) {
        current += dec / 10;
        hasNumber = true;
      }
      continue;
    }

    if (NUMBER_WORDS[token] !== undefined) {
      current += NUMBER_WORDS[token];
      hasNumber = true;
    } else if (token === 'hundred') {
      current = (current === 0 ? 1 : current) * 100;
      hasNumber = true;
    } else if (token === 'thousand') {
      total += (current === 0 ? 1 : current) * 1000;
      current = 0;
      hasNumber = true;
    } else if (token === 'million') {
      total += (current === 0 ? 1 : current) * 1000000;
      current = 0;
      hasNumber = true;
    } else if (token === 'billion') {
      total += (current === 0 ? 1 : current) * 1000000000;
      current = 0;
      hasNumber = true;
    } else if (!isNaN(parseFloat(token))) {
      current += parseFloat(token);
      hasNumber = true;
    } else {
      return null;
    }
  }
  return hasNumber ? (total + current) : null;
}

function normalizeNumberWords(text) {
  if (!text || typeof text !== 'string') return text;
  // Protect spelled-number hyphenated compounds (two-phase, one-way,
  // zero-trust, three-tier): the number word is part of a technical term,
  // not a quantity. True number phrases (twenty-one) stay unprotected.
  let s = text.replace(/\b(zero|one|two|three|four|five|six|seven|eight|nine|ten)-([a-z]+)\b/gi, (m, num, rest) =>
    (NUMBER_WORDS[rest.toLowerCase()] !== undefined || /^(hundred|thousand|million|billion)$/i.test(rest))
      ? m
      : `___NUMWORD_${num.toLowerCase()}_${rest.toLowerCase()}___`);

  const NUM_WORD_PATTERN = /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[-\s]+(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|and|point|[0-9]+))*\b/gi;

  s = s.replace(NUM_WORD_PATTERN, (match) => {
    const val = parseNumberWordPhrase(match);
    return val !== null ? String(val) : match;
  });

  s = s.replace(/(\d+(?:\.\d+)?)\s*(?:percent|percentage)\b/gi, '$1%');
  s = s.replace(/(\d+(?:\.\d+)?)\s*(?:dollars?|usd)\b/gi, '$$$1');
  s = s.replace(/___NUMWORD_([a-z]+)_([a-z]+)___/g, '$1-$2');
  return s;
}

function getBaseUnit(unit) {
  if (!unit) return '';
  let u = unit.toLowerCase().trim();
  const parts = u.split(/\s+/);
  if (parts.length > 1) {
    u = parts[parts.length - 1];
  }
  if (u.endsWith('ies')) u = u.slice(0, -3) + 'y';
  else if (/(?:ss|[xz]|[sc]h)es$/i.test(u)) u = u.slice(0, -2);
  else if (u.endsWith('s') && !u.endsWith('ss') && u !== 'redis' && u !== 'postgres' && u !== 'aws') u = u.slice(0, -1);
  return u;
}

function getTitleSeniority(title) {
  if (!title || typeof title !== 'string') return 0;
  const t = title.toLowerCase();
  if (/\b(?:chief\s+[a-z]+|cto|ceo|cio|ciso|cpo|coo)\b/i.test(t)) return 6;
  if (/\b(?:vice\s+president|vp|svp|evp)\b/i.test(t)) return 5;
  if (/\b(?:head\s+of|director|managing\s+director)\b/i.test(t)) return 4;
  if (/\b(?:principal|fellow|distinguished)\b/i.test(t)) return 3;
  if (/\b(?:staff|lead)\b/i.test(t)) return 2;
  if (/\b(?:senior|sr\.)\b/i.test(t)) return 1;
  return 0;
}

function normalizeCompValue(str) {
  if (!str) return '';
  const s = str.trim().toLowerCase();
  const latMatch = s.match(/^(\d+(?:\.\d+)?)\s*(ms|milliseconds|s|seconds)$/);
  if (latMatch) {
    let ms = parseFloat(latMatch[1]);
    if (latMatch[2] === 's' || latMatch[2] === 'seconds') ms = Math.round(ms * 1000);
    return `${ms}ms`;
  }
  const pctMatch = s.match(/^(\d+(?:\.\d+)?)\s*%$/);
  if (pctMatch) return `${parseFloat(pctMatch[1])}%`;
  const durMatch = s.match(/^(\d+(?:\.\d+)?)\s*([a-z]+)$/);
  if (durMatch) {
    const unit = getBaseUnit(durMatch[2]);
    return `${parseFloat(durMatch[1])} ${unit}`;
  }
  return s;
}

function extractComparatives(text) {
  if (!text || typeof text !== 'string') return [];
  const results = [];
  const compRegex = /\bfrom\s+(\d+(?:\.\d+)?\s*(?:%|ms|milliseconds|s|seconds|days?|weeks?|months?|hours?|templates?|pods?|services?)?)\s+(?:down\s+to|to)\s+(?:just\s+|under\s+|approximately\s+|nearly\s+|around\s+)?(\d+(?:\.\d+)?\s*(?:%|ms|milliseconds|s|seconds|days?|weeks?|months?|hours?|templates?|pods?|services?)?)(?!\w)/gi;
  let match;
  while ((match = compRegex.exec(text)) !== null) {
    let before = match[1].trim();
    let after = match[2].trim();
    const unitMatchB = before.match(/^[0-9.]+\s*([a-z%]+)$/i);
    const unitMatchA = after.match(/^[0-9.]+\s*([a-z%]+)$/i);
    if (!unitMatchB && unitMatchA) {
      before = `${before} ${unitMatchA[1]}`;
    } else if (unitMatchB && !unitMatchA) {
      after = `${after} ${unitMatchB[1]}`;
    }
    results.push({
      raw: match[0],
      before,
      after,
      index: match.index
    });
  }
  const compInverseRegex = /\b(?:down\s+to|to)\s+(?:just\s+|under\s+|approximately\s+|nearly\s+|around\s+)?(\d+(?:\.\d+)?\s*(?:%|ms|milliseconds|s|seconds|days?|weeks?|months?|hours?|templates?|pods?|services?)?)\s+from\s+(?:an?\s+(?:initial|baseline|previous)\s+)?(\d+(?:\.\d+)?\s*(?:%|ms|milliseconds|s|seconds|days?|weeks?|months?|hours?|templates?|pods?|services?)?)(?!\w)/gi;
  while ((match = compInverseRegex.exec(text)) !== null) {
    let after = match[1].trim();
    let before = match[2].trim();
    const unitMatchB = before.match(/^[0-9.]+\s*([a-z%]+)$/i);
    const unitMatchA = after.match(/^[0-9.]+\s*([a-z%]+)$/i);
    if (!unitMatchB && unitMatchA) {
      before = `${before} ${unitMatchA[1]}`;
    } else if (unitMatchB && !unitMatchA) {
      after = `${after} ${unitMatchB[1]}`;
    }
    results.push({
      raw: match[0],
      before,
      after,
      index: match.index
    });
  }
  return results;
}

const TECH_VERSION_PATTERNS = [
  /\bOAuth\s*2(?:\.0)?\b/gi,
  /\bHTTP\s*\/\s*[123](?:\.[01])?\b/gi,
  /\bLayer\s*[47]\b/gi,
  /\bL[47]\b/gi,
  /\bTLS\s*1\.[23]\b/gi,
  /\bSSL\s*[23](?:\.0)?\b/gi,
  /\bISO\s*27001\b/gi,
  /\bSOC\s*2\b/gi,
  /\bFIPS\s*140-2\b/gi,
  /\bPCI-DSS\s*3\.2\b/gi,
  /\bIPv[46]\b/gi,
  /\bS3\b/gi,
  /\bEC2\b/gi,
  /\bARM64\b/gi,
  /\bx86[-_]64\b/gi,
  /\bx86\b/gi,
  /\bamd64\b/gi,
  /\bSHA-?(?:256|512|1)\b/gi,
  /\bAES-?(?:128|192|256)\b/gi,
  /\bRSA-?(?:1024|2048|4096)\b/gi,
  /\bPython\s*3(?:\.\d+)?\b/gi,
  /\bNode(?:\.js)?\s*(?:16|18|20|22)\b/gi,
  /\bWeb3\b/gi,
  /\b3D\b/gi,
  /\bp(?:99|95|90|50)\b/gi,
  /\b30\s+under\s+30\b/gi,
  /\b40\s+under\s+40\b/gi,
  /\bzero-(?:trust|downtime|copy)\b/gi,
  // The national programme name, not a quantity (exact phrase only).
  /\bVision\s+2030\b/gi,
  /رؤية\s+2030\b/g
];

/**
 * A claim counts as confirmed only when its status is VERIFIED. A claim with
 * no status at all is the legacy shape CareerDossier also reads as VERIFIED.
 * Anything else (CONFIRM, or any unknown value) is unconfirmed.
 */
function isConfirmedClaim(claim) {
  return Boolean(claim) && (claim.status == null || claim.status === 'VERIFIED');
}

/**
 * Masks the candidate's own email and phone number (exactly as recorded in the
 * dossier, ignoring phone separators) so a CV header is not read as metrics.
 */
function maskCandidateContact(text, candidate) {
  if (!candidate) return text;
  let s = text;
  const email = String(candidate.email || '').trim();
  if (email.includes('@')) {
    s = s.replace(new RegExp(`(?<![\\w.+-])${escapeRegExp(email)}(?![\\w-])`, 'gi'), ' [email] ');
  }
  const digits = String(candidate.phone || '').replace(/\D/g, '');
  if (digits.length >= 7) {
    const body = digits.split('').join('[\\s().-]*');
    s = s.replace(new RegExp(`(?<![\\d+])\\+?\\(?${body}(?!\\d)`, 'g'), ' [phone] ');
  }
  return s;
}

// GCC countries and major cities, plus the places already accepted before.
const KNOWN_PLACES = /^(?:saudi arabia|ksa|riyadh|jeddah|dammam|khobar|al khobar|dhahran|jubail|makkah|mecca|madinah|medina|tabuk|uae|united arab emirates|dubai|abu dhabi|sharjah|qatar|doha|bahrain|manama|kuwait|kuwait city|oman|muscat|london|cambridge|uk|usa|remote)$/i;

const NOT_PAST_TENSE = /^(?:interested|excited|thrilled|delighted|motivated|pleased|based|located|stationed|advertised|posted|listed|described|need|speed|indeed|proceed|succeed|exceed)$/i;

/**
 * True when the words leading up to "at <Org>" speak of applying to, joining
 * or being located at the organisation — and say nothing in the past tense.
 * Used for the target vacancy's company and for NEOM (a place that is also an
 * employer): both are known entities there, never as a claimed employer.
 */
function isApplicationOrLocationContext(textBefore) {
  const clause = textBefore.split(/[,;:]/).pop();
  const hasCue = /\b(?:apply(?:ing)?|application|candidacy|interest(?:ed)?\s+in|opportunity|vacancy|(?:to|would|will)\s+join)\b/i.test(clause) ||
    /(?<![-\w])(?:based|located|relocat(?:e|ing)|on[- ]?site)\s*$/i.test(clause);
  if (!hasCue) return false;
  if (/\b(?:was|were|been|had|built|ran|grew|drove|held|began|took|made|won|led|oversaw|years?|while|since|during|tenure|former(?:ly)?|previous(?:ly)?)\b/i.test(clause)) return false;
  return !(clause.match(/\b[a-z]+ed\b/gi) || []).some(w => !NOT_PAST_TENSE.test(w));
}

const DATE_PATTERNS = [
  /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}\b/gi,
  /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{4}\b/gi,
  /\b\d{4}[-/]\d{1,2}[-/]\d{1,2}\b/g,
  /\b\d{1,2}[-/]\d{1,2}[-/]\d{2,4}\b/g
];

function extractNumericTokens(text) {
  if (!text || typeof text !== 'string') return [];
  let s = normalizeNumberWords(text);
  for (const pat of TECH_VERSION_PATTERNS) {
    s = s.replace(pat, ' ___TECH___ ');
  }
  for (const pat of DATE_PATTERNS) {
    s = s.replace(pat, ' ___DATE___ ');
  }
  s = s.replace(/\b\d+(?:st|nd|rd|th)\b/gi, ' ___ORDINAL___ ');
  // Mask decimal and standard duration/latency units before token extraction
  s = s.replace(/(?:\b\d+(?:\.\d+)?|\.\d+)\s*(?:ms|milliseconds)\b/gi, ' ___LATENCY___ ');
  s = s.replace(/(?:\b\d+\.\d+|\.\d+)\s*(?:s|seconds)\b/gi, ' ___LATENCY___ ');
  s = s.replace(/\b\d+\s*seconds\b/gi, ' ___LATENCY___ ');
  s = s.replace(/\b\d{1,3}\s*s\b/gi, ' ___LATENCY___ ');

  const numbers = [];
  const numRegex = /\b(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)\b/g;
  let m;
  while ((m = numRegex.exec(s)) !== null) {
    const val = parseFloat(m[1].replace(/,/g, ''));
    if (!isNaN(val)) {
      numbers.push({
        raw: m[1],
        val,
        index: m.index
      });
    }
  }
  return numbers;
}

/**
 * Extracts numbers, metrics, tools, and entity mentions from text.
 * @param {string} text Input draft text
 * @returns {Object} Extracted entities with normalized values and units
 */
function extractEntities(text) {
  if (!text || typeof text !== 'string') {
    return {
      metrics: [],
      latencies: [],
      percentages: [],
      currencies: [],
      throughputs: [],
      counts: [],
      headcounts: []
    };
  }

  const normText = normalizeNumberWords(text);

  // 1. Latencies (e.g. 180ms, 42ms, 10ms, 41ms, 5ms, 20ms, 0.042s, 0.010s, 3.8s, 1.1s, 10 milliseconds)
  const latencies = [];
  const latencyRegex = /(\d+(?:\.\d+)?)\s*(ms|milliseconds|s|seconds)\b/gi;
  let match;
  while ((match = latencyRegex.exec(normText)) !== null) {
    const rawVal = parseFloat(match[1]);
    const unit = match[2].toLowerCase();
    let msVal = rawVal;
    if (unit === 's' || unit === 'seconds') {
      msVal = Math.round(rawVal * 1000);
    }
    latencies.push({
      raw: match[0].trim(),
      rawVal,
      unit,
      msVal,
      index: match.index
    });
  }

  // 2. Percentages (e.g. 75%, 80%, 34%, 99.99%, 62%, 54%, 88%, 19%, 25%, 50%)
  const percentages = [];
  const percentRegex = /(?:^|\s|\b)(\d+(?:\.\d+)?)\s*%(?!\w)/g;
  while ((match = percentRegex.exec(normText)) !== null) {
    percentages.push({
      raw: match[0].trim(),
      value: parseFloat(match[1]),
      index: match.index
    });
  }

  // 3. Monetary / Currencies (e.g. $2,500,000, $2.5M, $480,000, $12,000,000, $50 million, GBP 140 million, 3 million dollars)
  const currencies = [];
  const currRegex = /(?:(\$|USD|GBP|EUR|SAR|AED)\s*(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)\s*(k|m|b|thousand|million|billion)?|(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)\s*(k|m|b|thousand|million|billion)?\s*(dollars?|usd|gbp|eur|sar|aed))\b/gi;
  while ((match = currRegex.exec(normText)) !== null) {
    let sym, numPart, multStr;
    if (match[1]) {
      sym = match[1].toUpperCase() === '$' ? 'USD' : match[1].toUpperCase();
      numPart = parseFloat(match[2].replace(/,/g, ''));
      multStr = (match[3] || '').toLowerCase();
    } else {
      sym = match[6].toUpperCase();
      if (sym.startsWith('DOLLAR')) sym = 'USD';
      numPart = parseFloat(match[4].replace(/,/g, ''));
      multStr = (match[5] || '').toLowerCase();
    }
    let mult = 1;
    if (multStr === 'k' || multStr === 'thousand') mult = 1e3;
    else if (multStr === 'm' || multStr === 'million') mult = 1e6;
    else if (multStr === 'b' || multStr === 'billion') mult = 1e9;
    currencies.push({
      raw: match[0].trim(),
      currency: sym,
      rawNum: numPart,
      amount: numPart * mult,
      index: match.index
    });
  }

  // 4. Throughputs / Rates (e.g. 500,000 RPS, 14,000 requests per second, 50,000 metrics/sec)
  const throughputs = [];
  const tpRegex = /(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+)\s*(?:peak\s*)?(?:requests\s*per\s*second|rps|metrics\s*(?:\/|per\s*)sec(?:ond)?|events\s*(?:\/|per\s*)sec(?:ond)?)\b/gi;
  while ((match = tpRegex.exec(normText)) !== null) {
    throughputs.push({
      raw: match[0].trim(),
      rate: parseFloat(match[1].replace(/,/g, '')),
      index: match.index
    });
  }

  // 5. Counts with scale/unit (e.g. 600 pods, 120+ microservices, 8 engineers, 45 clusters, 25 projects, 50 accounts)
  const counts = [];
  const headcounts = [];
  const NON_COUNT_NOUNS = new Set([
    'ms', 'rps', 'is', 'was', 'has', 'this', 'less', 'plus', 'across', 'status',
    'consensus', 'analysis', 'basis', 'canvas', 'focus', 'express', 'postgres',
    'redis', 'kubernetes', 'istio', 'aws', 'percent', 'percentage', 'dollars',
    'dollar', 'usd', 'gbp', 'eur', 'sar', 'aed', 'seconds', 'milliseconds', 'p99', 'p95', 'p50',
    'sla', 'scale', 'k8s', 'mau', 'annually', 'daily', 'monthly', 'weekly', 'hourly', 'saving', 'savings', 'mtls', 'spiffe', 'time', 'times'
  ]);

  let textForCounts = normText;
  const currMaskRegex = /(?:(\$|£|€|USD|GBP|EUR|SAR|AED)\s*(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)\s*(k|m|b|thousand|million|billion)?|(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)\s*(k|m|b|thousand|million|billion)?\s*(dollars?|pounds?|euros?|usd|gbp|eur|sar|aed))\b/gi;
  textForCounts = textForCounts.replace(currMaskRegex, ' ___CURRENCY___ ');

  for (const pat of TECH_VERSION_PATTERNS) {
    textForCounts = textForCounts.replace(pat, ' ___TECH___ ');
  }
  for (const pat of DATE_PATTERNS) {
    textForCounts = textForCounts.replace(pat, ' ___DATE___ ');
  }
  textForCounts = textForCounts.replace(/\b\d+(?:st|nd|rd|th)\b/gi, ' ___ORDINAL___ ');

  const phraseRegex = /(?<![\$£€,0-9]|\b(?:USD|GBP|EUR|SAR|AED)\s*)\b(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)\s*(million\s+|billion\s+)?(?:\+|\s|-|\b)\s*([a-zA-Z0-9_/-]+(?:\s+[a-zA-Z0-9_/-]+)*?)(?=\s+(?:while|using|through|delivering|leading|reducing|increasing|sustaining|preserving|improving|cutting|saving|handling|processing|hosting|managing|maintaining|operating|serving|resulting|generating|enabling|via)\b|\s+(?:at|while\s+at|for|with|in|across|over|from|into|onto)\s+(?:[A-Z]|\d)|\s+(?:and|or)\s+(?:managed|maintained|led|operated|built|delivered|deployed|engineered|reduced|oversaw)\b|[,.;!?]|\s*$)\b/gi;
  while ((match = phraseRegex.exec(textForCounts)) !== null) {
    const rawValStr = match[1].replace(/,/g, '');
    const baseVal = parseFloat(rawValStr);
    const multStr = (match[2] || '').trim().toLowerCase();
    let mult = 1;
    if (multStr === 'million') mult = 1e6;
    if (multStr === 'billion') mult = 1e9;

    let words = match[3].trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;

    // A second quantity embedded in the phrase ("10 clusters and 25
    // microservices") starts its own count: truncate this phrase at that
    // number and rewind so the next iteration extracts it separately.
    const embeddedNumIdx = words.findIndex((w, i) => i > 0 && /^\d/.test(w));
    if (embeddedNumIdx > 0) {
      const numOffset = match[3].search(/\s\d/);
      if (numOffset >= 0) {
        phraseRegex.lastIndex = match.index + match[0].indexOf(match[3]) + numOffset + 1;
      }
      words = words.slice(0, embeddedNumIdx);
      while (words.length && /^(and|or|,)$/i.test(words[words.length - 1])) words.pop();
      if (words.length === 0) continue;
    }

    let chosenNounIndex = -1;
    // A duration directly after the number ("8 years of ...") is the unit;
    // trailing nouns describe the field, not what was counted.
    if (/^(year|years|month|months|week|weeks|day|days|hour|hours)$/i.test(words[0])) {
      chosenNounIndex = 0;
    }
    for (let i = words.length - 1; chosenNounIndex === -1 && i >= 0; i--) {
      const candidateNoun = words[i].toLowerCase();
      if (NON_COUNT_NOUNS.has(candidateNoun)) continue;
      if (candidateNoun.endsWith('s') ||
          /^(people|person|staff|report|reports|member|members|developer|developers|engineer|engineers|architect|architects)$/.test(candidateNoun) ||
          /^(day|week|month|year|project|site|cluster|account|deliverable|hour|pod|service|microservice|node|template|pipeline|database|table|squad|application|app|facility|storefront|client|brand|instance|repo|repository)$/.test(candidateNoun)) {
        chosenNounIndex = i;
        break;
      }
    }

    if (chosenNounIndex === -1 && words.length > 0) {
      const last = words[words.length - 1].toLowerCase();
      if (!NON_COUNT_NOUNS.has(last) && !/^\d+$/.test(last)) {
        chosenNounIndex = words.length - 1;
      }
    }

    if (chosenNounIndex === -1) continue;

    const rawNoun = words[chosenNounIndex].toLowerCase();
    const modifier = words.slice(0, chosenNounIndex).join(' ');
    const unit = (modifier ? `${modifier} ${rawNoun}` : rawNoun).toLowerCase();
    const baseUnit = getBaseUnit(rawNoun);
    const total = baseVal * mult;
    const isHeadcount = /^(people|member|engineer|software engineer|developer|report|direct report|staff)$/.test(baseUnit);
    const rawPhrase = `${match[1]}${multStr ? ' ' + multStr : ''} ${unit}`;

    counts.push({
      raw: rawPhrase,
      modifier,
      rawNoun,
      unit,
      baseUnit,
      total,
      isHeadcount,
      index: match.index
    });

    if (isHeadcount) {
      headcounts.push({
        raw: rawPhrase,
        count: total,
        unit,
        baseUnit,
        index: match.index
      });
    }
  }

  // Explicit team/division/squad leadership phrases (e.g. "team of N people", "division of N engineers", "led a team of N")
  const teamPhraseRegex = /\b(?:team|division|group|squad|organization|org)\s+(?:of\s+)?(\d+)\b/gi;
  while ((match = teamPhraseRegex.exec(normText)) !== null) {
    const count = parseInt(match[1], 10);
    if (!headcounts.some(h => h.count === count)) {
      headcounts.push({
        raw: match[0].trim(),
        count,
        unit: 'people',
        baseUnit: 'people',
        index: match.index
      });
      counts.push({
        raw: match[0].trim(),
        unit: 'people',
        baseUnit: 'people',
        total: count,
        isHeadcount: true,
        index: match.index
      });
    }
  }

  // General legacy metrics list for backwards-compatibility
  const metrics = [];
  const numRegex = /(\$|GBP|SAR|AED)?\s*(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+)\s*(%|ms|s|k|M|B|rps|billion|million|pods|services|templates|squads|engineers|months)?/gi;
  while ((match = numRegex.exec(normText)) !== null) {
    metrics.push({
      raw: match[0].trim(),
      currency: match[1] || null,
      value: match[2].replace(/,/g, ''),
      unit: match[3] || null,
      index: match.index
    });
  }

  return {
    metrics,
    latencies,
    percentages,
    currencies,
    throughputs,
    counts,
    headcounts
  };
}

const TECH_CATALOG = [
  // --- Workflow Orchestrators ---
  { name: 'apache airflow', regex: /\b(?:apache\s+)?airflow\b/i },
  { name: 'temporal', regex: /\btemporal(?:\.io)?\b/i },
  { name: 'prefect', regex: /\bprefect\b/i },
  { name: 'dagster', regex: /\bdagster\b/i },
  { name: 'luigi', regex: /\bluigi\b/i },
  { name: 'argo', regex: /\bargo(?:\s+workflows|\s+cd)?\b/i },
  { name: 'kubeflow', regex: /\bkubeflow\b/i },
  { name: 'camunda', regex: /\bcamunda\b/i },
  { name: 'celery', regex: /\bcelery\b/i },
  { name: 'aws step functions', regex: /\b(?:aws\s+)?step\s+functions\b/i },
  { name: 'airbyte', regex: /\bairbyte\b/i },
  { name: 'n8n', regex: /\bn8n\b/i },

  // --- Programming Languages ---
  { name: 'ruby', regex: /\bruby(?:\s+on\s+rails)?\b/i },
  { name: 'c#', regex: /\b(?:c#|csharp|\.net\s+core|\.net)(?!\w)/i },
  { name: 'c++', regex: /\b(?:c\+\+|cpp)(?!\w)/i },
  { name: 'java', regex: /\bjava\b(?!script)/i },
  { name: 'php', regex: /\bphp\b/i },
  { name: 'dart', regex: /\bdart\b/i },
  { name: 'julia', regex: /\bjulia\b/i },
  { name: 'clojure', regex: /\bclojure\b/i },
  { name: 'rust', regex: /\brust\b/i },
  { name: 'go', regex: /\b(?:golang|\bgo\b(?=\s+(?:microservices?|backend|developer|engineer|routines?|modules?|services?|code|concurrency|channels?|programming|language))\b|(?:using|in|with)\s+go\b)/i },
  { name: 'scala', regex: /\bscala\b/i },
  { name: 'elixir', regex: /\belixir\b/i },
  { name: 'kotlin', regex: /\bkotlin\b/i },
  { name: 'swift', regex: /\bswift\b/i },
  { name: 'python', regex: /\bpython(?:3)?\b/i },
  { name: 'typescript', regex: /\btypescript\b/i },
  { name: 'javascript', regex: /\bjavascript\b/i },
  { name: 'r', regex: /\b(?:r\s+language|r\s+programming|\br\s+package|(?:using|in|with)\s+R)\b/ },
  { name: 'perl', regex: /\bperl\b/i },
  { name: 'haskell', regex: /\bhaskell\b/i },
  { name: 'lua', regex: /\blua\b/i },
  { name: 'ocaml', regex: /\bocaml\b/i },
  { name: 'zig', regex: /\bzig\b/i },
  { name: 'solidity', regex: /\bsolidity\b/i },

  // --- Infrastructure as Code & Cloud Platforms ---
  { name: 'terraform', regex: /\bterraform\b/i },
  { name: 'terraformcloud', regex: /\bterraformcloud\b/i },
  { name: 'ansible', regex: /\bansible\b/i },
  { name: 'pulumi', regex: /\bpulumi\b/i },
  { name: 'cloudformation', regex: /\bcloudformation\b/i },
  { name: 'aws lambda', regex: /\b(?:aws\s+)?lambda\b/i },

  // --- Distributed Data & Streaming ---
  { name: 'apache spark', regex: /\b(?:apache\s+)?spark\b/i },
  { name: 'apache flink', regex: /\b(?:apache\s+)?flink\b/i },
  { name: 'apache beam', regex: /\b(?:apache\s+)?beam\b/i },
  { name: 'apache kafka', regex: /\b(?:apache\s+)?kafka\b/i },
  { name: 'rabbitmq', regex: /\brabbitmq\b/i },
  { name: 'apache pulsar', regex: /\b(?:apache\s+)?pulsar\b/i },
  { name: 'snowflake', regex: /\bsnowflake\b/i },
  { name: 'databricks', regex: /\bdatabricks\b/i },
  { name: 'dbt', regex: /\bdbt\b/i },
  { name: 'hadoop', regex: /\bhadoop\b/i },
  { name: 'hive', regex: /\bhive\b/i },

  // --- Databases & Storage ---
  { name: 'dynamodb', regex: /\bdynamodb\b/i },
  { name: 'cassandra', regex: /\bcassandra\b/i },
  { name: 'couchbase', regex: /\bcouchbase\b/i },
  { name: 'mongodb', regex: /\bmongodb\b/i },
  { name: 'neo4j', regex: /\bneo4j\b/i },
  { name: 'bigquery', regex: /\bbigquery\b/i },
  { name: 'redshift', regex: /\bredshift\b/i },
  { name: 'cockroachdb', regex: /\bcockroachdb\b|\bcockroach\s+db\b/i },
  { name: 'scylladb', regex: /\bscylladb\b/i },
  { name: 'clickhouse', regex: /\bclickhouse\b/i },

  // --- Frameworks & Libraries ---
  { name: 'pytorch', regex: /\bpytorch\b/i },
  { name: 'tensorflow', regex: /\btensorflow\b/i },
  { name: 'keras', regex: /\bkeras\b/i },
  { name: 'fastapi', regex: /\bfastapi\b/i },
  { name: 'django', regex: /\bdjango\b/i },
  { name: 'flask', regex: /\bflask\b/i },
  { name: 'spring boot', regex: /\bspring\s+boot\b/i },
  { name: 'vue', regex: /\bvue(?:\.js|js)?\b/i },
  { name: 'angular', regex: /\bangular(?:\.js|js)?\b/i },
  { name: 'phoenix', regex: /\bphoenix(?:\s+framework)?\b/i },
  { name: 'graphql', regex: /\bgraphql\b/i },
  { name: 'salesforce', regex: /\bsalesforce(?:\s+crm)?\b/i },
  { name: 'jenkins', regex: /\bjenkins\b/i },
  { name: 'circleci', regex: /\bcircleci\b/i }
];

const CREDENTIAL_CATALOG = [
  { name: 'AWS Certified Solutions Architect Professional', regex: /\bAWS\s+Certified\s+Solutions\s+Architect\s+Professional\b/i },
  { name: 'AWS Certified', regex: /\bAWS\s+Certified\b/i },
  { name: 'Google Cloud Fellow', regex: /\bGoogle\s+Cloud\s+Fellow\b/i },
  { name: 'Google Cloud Certified', regex: /\bGoogle\s+Cloud\s+Certified\b/i },
  { name: 'Azure Certified', regex: /\bAzure\s+(?:Certified|Solutions\s+Architect)\b/i },
  { name: 'CISSP', regex: /\bCISSP\b/i },
  { name: 'CompTIA Security+', regex: /\bCompTIA\s+Security\+?\b/i },
  { name: 'CompTIA', regex: /\bCompTIA\b/i },
  { name: 'PMP', regex: /\bPMP\b/i }
];

class ClaimVerifier {
  /**
   * Evaluates a single draft sentence or test case against candidate dossier.
   * @param {Object|string} draftCase Case object or plain sentence string
   * @param {Object} dossier Candidate dossier object
   * @param {Object} [options]
   * @param {string} [options.targetCompany] Company of the vacancy the draft is written for
   * @returns {{ passed: boolean, violations: Array<{ code: string, details: string, [key: string]: any }> }}
   */
  static verifySentence(draftCase, dossier, options = {}) {
    const isObject = typeof draftCase === 'object' && draftCase !== null;
    const rawText = isObject ? (draftCase.draftText || draftCase.text || draftCase.content || '') : String(draftCase);
    // The candidate's own contact details are not metrics.
    const text = maskCandidateContact(rawText, dossier.candidate);
    const claimIds = isObject ? (draftCase.claimIds || []) : [];
    const targetCompany = String(options.targetCompany || '').toLowerCase().trim();

    const violations = [];

    // Collect allowed baseline metrics, tools, employers, credentials from dossier
    const allowedLatenciesMs = new Set();
    const allowedPercentages = new Set();
    const allowedAmounts = new Set();
    const allowedThroughputs = new Set();
    const allowedHeadcounts = new Set();
    const allowedCountsByUnit = {};
    const verifiedComparatives = [];
    const candidateTools = new Set();
    const candidateCerts = new Set();
    const candidateDegrees = new Set();
    const candidateInstitutions = new Set();

    const employers = dossier.employers || [];
    const claims = dossier.claims || [];
    // Only confirmed claims may support a draft; unconfirmed ones are gated below.
    const confirmedClaims = claims.filter(isConfirmedClaim);
    const unconfirmedClaims = claims.filter(c => !isConfirmedClaim(c));

    // Extract verified baselines from claims
    for (const clm of confirmedClaims) {
      const allText = `${clm.text}. ${(clm.metrics || []).join('. ')}.`;
      const entities = extractEntities(allText);

      for (const lat of entities.latencies) {
        allowedLatenciesMs.add(lat.msVal);
      }
      for (const pct of entities.percentages) {
        allowedPercentages.add(pct.value);
      }
      for (const curr of entities.currencies) {
        allowedAmounts.add(curr.amount);
      }
      for (const tp of entities.throughputs) {
        allowedThroughputs.add(tp.rate);
      }
      for (const hc of entities.headcounts) {
        allowedHeadcounts.add(hc.count);
      }
      for (const cnt of entities.counts) {
        if (!allowedCountsByUnit[cnt.unit]) {
          allowedCountsByUnit[cnt.unit] = new Set();
        }
        allowedCountsByUnit[cnt.unit].add(cnt.total);
        if (cnt.baseUnit) {
          if (!allowedCountsByUnit[cnt.baseUnit]) {
            allowedCountsByUnit[cnt.baseUnit] = new Set();
          }
          allowedCountsByUnit[cnt.baseUnit].add(cnt.total);
        }
      }

      // Extract verified comparative pairs
      const claimComps = extractComparatives(allText);
      for (const comp of claimComps) {
        verifiedComparatives.push({
          claimId: clm.id,
          employerId: clm.employerId,
          before: comp.before,
          after: comp.after,
          normBefore: normalizeCompValue(comp.before),
          normAfter: normalizeCompValue(comp.after)
        });
      }

      for (const t of clm.tools || []) {
        const norm = t.toLowerCase().trim();
        candidateTools.add(norm);
        if (norm === 'go') candidateTools.add('golang');
        if (norm === 'golang') candidateTools.add('go');
        if (norm === 'kubernetes') candidateTools.add('k8s');
        if (norm === 'k8s') candidateTools.add('kubernetes');
        if (norm === 'node.js') candidateTools.add('nodejs');
        if (norm === 'kafka') candidateTools.add('apache kafka');
        if (norm === 'apache kafka') candidateTools.add('kafka');
        if (norm === 'airflow') candidateTools.add('apache airflow');
        if (norm === 'apache airflow') candidateTools.add('airflow');
        if (norm === 'spark') candidateTools.add('apache spark');
        if (norm === 'apache spark') candidateTools.add('spark');
        if (norm === 'flink') candidateTools.add('apache flink');
        if (norm === 'apache flink') candidateTools.add('flink');
        if (norm === 'beam') candidateTools.add('apache beam');
        if (norm === 'apache beam') candidateTools.add('beam');
        if (norm === 'step functions') candidateTools.add('aws step functions');
        if (norm === 'aws step functions') candidateTools.add('step functions');
        if (norm === 'ruby on rails' || norm === 'rails') candidateTools.add('ruby');
        if (norm === 'csharp' || norm === 'c#' || norm === '.net') {
          candidateTools.add('c#');
          candidateTools.add('csharp');
          candidateTools.add('.net');
        }
        if (norm === 'cpp' || norm === 'c++') {
          candidateTools.add('c++');
          candidateTools.add('cpp');
        }
        if (norm === 'gitlab ci') candidateTools.add('gitlab');
        if (norm === 'react') candidateTools.add('reactjs');
        if (norm === 'next.js') candidateTools.add('nextjs');
      }
      for (const t of clm.technologies || []) {
        candidateTools.add(t.toLowerCase().trim());
      }
      for (const tech of TECH_CATALOG) {
        if (tech.regex.test(allText)) {
          candidateTools.add(tech.name);
        }
      }
    }

    // Extract metrics and counts from candidate profile summary if available
    if (dossier.candidate && dossier.candidate.summary) {
      const summaryEntities = extractEntities(dossier.candidate.summary);
      for (const cnt of summaryEntities.counts) {
        if (!allowedCountsByUnit[cnt.unit]) allowedCountsByUnit[cnt.unit] = new Set();
        allowedCountsByUnit[cnt.unit].add(cnt.total);
        if (cnt.baseUnit) {
          if (!allowedCountsByUnit[cnt.baseUnit]) allowedCountsByUnit[cnt.baseUnit] = new Set();
          allowedCountsByUnit[cnt.baseUnit].add(cnt.total);
        }
      }
    }

    // Career span calculation from verified employer history
    const startYears = employers.map(e => e.startYear).filter(Boolean);
    if (startYears.length > 0) {
      const earliestYear = Math.min(...startYears);
      const latestEndYears = employers.map(e => e.endYear).filter(Boolean);
      const isCurrentlyEmployed = employers.some(e => e.isCurrent || e.endYear === null);
      const latestYear = isCurrentlyEmployed ? new Date().getFullYear() : (latestEndYears.length > 0 ? Math.max(...latestEndYears) : earliestYear);
      // Inclusive calendar-year span: 2018 through 2026 touches 9 years.
      const careerYears = latestYear - earliestYear + 1;
      if (careerYears > 0) {
        if (!allowedCountsByUnit['year']) allowedCountsByUnit['year'] = new Set();
        if (!allowedCountsByUnit['years']) allowedCountsByUnit['years'] = new Set();
        for (let y = 1; y <= careerYears; y++) {
          allowedCountsByUnit['year'].add(y);
          allowedCountsByUnit['years'].add(y);
        }
      }
    }

    const maxVerifiedHeadcount = allowedHeadcounts.size > 0 ? Math.max(...allowedHeadcounts) : 0;

    // Include candidate skills if present
    if (dossier.skills) {
      const addSkill = (s) => {
        if (typeof s === 'string') {
          const norm = s.toLowerCase().trim();
          candidateTools.add(norm);
          if (norm === 'go') candidateTools.add('golang');
          if (norm === 'golang') candidateTools.add('go');
          if (norm === 'kubernetes') candidateTools.add('k8s');
          if (norm === 'k8s') candidateTools.add('kubernetes');
          if (norm === 'node.js') candidateTools.add('nodejs');
          if (norm === 'kafka') candidateTools.add('apache kafka');
          if (norm === 'apache kafka') candidateTools.add('kafka');
          if (norm === 'airflow') candidateTools.add('apache airflow');
          if (norm === 'apache airflow') candidateTools.add('airflow');
          if (norm === 'spark') candidateTools.add('apache spark');
          if (norm === 'apache spark') candidateTools.add('spark');
          if (norm === 'flink') candidateTools.add('apache flink');
          if (norm === 'apache flink') candidateTools.add('flink');
          if (norm === 'beam') candidateTools.add('apache beam');
          if (norm === 'apache beam') candidateTools.add('beam');
          if (norm === 'step functions') candidateTools.add('aws step functions');
          if (norm === 'aws step functions') candidateTools.add('step functions');
          if (norm === 'ruby on rails' || norm === 'rails') candidateTools.add('ruby');
          if (norm === 'csharp' || norm === 'c#' || norm === '.net') {
            candidateTools.add('c#');
            candidateTools.add('csharp');
            candidateTools.add('.net');
          }
          if (norm === 'cpp' || norm === 'c++') {
            candidateTools.add('c++');
            candidateTools.add('cpp');
          }
        }
      };

      if (Array.isArray(dossier.skills)) {
        dossier.skills.forEach(addSkill);
      } else if (typeof dossier.skills === 'object' && dossier.skills !== null) {
        for (const val of Object.values(dossier.skills)) {
          if (Array.isArray(val)) {
            val.forEach(addSkill);
          } else if (typeof val === 'string') {
            addSkill(val);
          }
        }
      }
    }

    // Collect verified certifications
    for (const cert of dossier.certifications || []) {
      const name = (typeof cert === 'string' ? cert : cert.name || '').toLowerCase();
      candidateCerts.add(name);
      if (name.includes('cka') || name.includes('certified kubernetes administrator')) {
        candidateCerts.add('cka');
        candidateCerts.add('certified kubernetes administrator');
      }
    }

    // Collect verified degrees and institutions
    for (const deg of dossier.degrees || []) {
      const dName = (typeof deg === 'string' ? deg : deg.degree || '').toLowerCase();
      const inst = (typeof deg === 'object' && deg.institution ? deg.institution : '').toLowerCase();
      candidateDegrees.add(dName);
      if (inst) candidateInstitutions.add(inst);
      if (dName.includes('ph.d') || dName.includes('doctor')) candidateDegrees.add('ph.d');
      if (dName.includes('b.sc') || dName.includes('bachelor')) candidateDegrees.add('b.sc');
      if (dName.includes('m.sc') || dName.includes('master of science')) candidateDegrees.add('m.sc');
      if (dName.includes('mba')) candidateDegrees.add('mba');
    }

    // Extract entities from draft sentence
    const normText = normalizeNumberWords(text);
    const draftEntities = extractEntities(text);

    // 1. Latency Verification (Numbers with ms / s / milliseconds)
    for (const lat of draftEntities.latencies) {
      if (!allowedLatenciesMs.has(lat.msVal)) {
        violations.push({
          code: VIOLATION_CODES.METRIC_INFLATION,
          detected: lat.raw,
          details: `Latency "${lat.raw}" (${lat.msVal}ms) is not supported by verified claims`
        });
      }
    }

    // 2. Percentage Verification
    for (const pct of draftEntities.percentages) {
      if (!allowedPercentages.has(pct.value)) {
        if (/expenditure|savings|compute|cloud|storage|cost|annual|budget/i.test(text)) {
          violations.push({
            code: VIOLATION_CODES.METRIC_INFLATION,
            detected: pct.raw,
            details: `Percentage "${pct.raw}" exceeds verified baseline`
          });
        } else {
          violations.push({
            code: VIOLATION_CODES.UNTAGGED_METRIC,
            detected: pct.raw,
            details: `Quantitative metric "${pct.raw}" introduced without backing verified claim`
          });
        }
      }
    }

    // 3. Currency / Monetary Value Verification
    for (const curr of draftEntities.currencies) {
      const isSalaryFloor = dossier.candidate && dossier.candidate.salaryFloor && (
        curr.amount === dossier.candidate.salaryFloor.minimumBase ||
        curr.amount === dossier.candidate.salaryFloor.targetTotal
      );

      if (!allowedAmounts.has(curr.amount) && !isSalaryFloor) {
        if (/operating budget/i.test(text)) {
          if (!violations.some(v => v.code === VIOLATION_CODES.SCOPE_INFLATION)) {
            violations.push({
              code: VIOLATION_CODES.SCOPE_INFLATION,
              detected: curr.raw,
              details: `Unverified operating budget "${curr.raw}"`
            });
          }
        } else if (/savings|save|infrastructure|cost|compute/i.test(text)) {
          violations.push({
            code: VIOLATION_CODES.METRIC_INFLATION,
            detected: curr.raw,
            details: `Monetary savings "${curr.raw}" exceed verified baseline`
          });
        } else {
          violations.push({
            code: VIOLATION_CODES.UNTAGGED_METRIC,
            detected: curr.raw,
            details: `Untagged monetary metric "${curr.raw}" absent from dossier`
          });
        }
      }
    }

    // 4. Throughput Verification
    for (const tp of draftEntities.throughputs) {
      if (!allowedThroughputs.has(tp.rate)) {
        violations.push({
          code: VIOLATION_CODES.METRIC_INFLATION,
          detected: tp.raw,
          details: `Throughput "${tp.raw}" exceeds verified baseline`
        });
      }
    }

    // 5. Unsupported Tools Check
    for (const tech of TECH_CATALOG) {
      if (tech.regex.test(text)) {
        const normTech = tech.name.toLowerCase();
        const isKnown = candidateTools.has(normTech) || [...candidateTools].some(ct => {
          const normCt = ct.toLowerCase();
          if (normCt === normTech) return true;
          // Word-bounded alias matching: both >= 4 chars, ensure short tools like 'go' never match inside 'django' or 'mongodb'
          if (normCt.length >= 4 && normTech.length >= 4) {
            const regexCt = new RegExp(`\\b${escapeRegExp(normCt)}\\b`, 'i');
            const regexTech = new RegExp(`\\b${escapeRegExp(normTech)}\\b`, 'i');
            return regexCt.test(normTech) || regexTech.test(normCt);
          }
          return false;
        });
        if (!isKnown) {
          violations.push({
            code: VIOLATION_CODES.UNSUPPORTED_TOOL,
            tool: tech.name,
            details: `Technology "${tech.name}" is not documented in candidate dossier`
          });
        }
      }
    }

    // 6. Dynamic Headcount and Scale Count Verification
    for (const hc of draftEntities.headcounts) {
      if (!allowedHeadcounts.has(hc.count) && hc.count > maxVerifiedHeadcount) {
        violations.push({
          code: VIOLATION_CODES.SCOPE_INFLATION,
          detected: hc.raw,
          details: `Team leadership headcount "${hc.raw}" (${hc.count}) exceeds verified baseline of ${maxVerifiedHeadcount}`
        });
      }
    }

    for (const cnt of draftEntities.counts) {
      if (!cnt.isHeadcount) {
        let allowedForUnit = allowedCountsByUnit[cnt.baseUnit] || allowedCountsByUnit[cnt.unit];
        if (cnt.baseUnit === 'microservice' || cnt.baseUnit === 'service') {
          const sSet = allowedCountsByUnit['service'];
          const msSet = allowedCountsByUnit['microservice'];
          if (sSet || msSet) {
            allowedForUnit = new Set([...(sSet || []), ...(msSet || [])]);
          }
        }
        if (allowedForUnit) {
          const maxAllowed = Math.max(...allowedForUnit);
          const isScaleUnit = /^(project|cluster|account|squad|template|microservice|service|pod|site|facility|deliverable|storefront|node|repo|repository|pipeline|client|brand|instance|database|table|application|app)$/i.test(cnt.baseUnit) ||
            /^(project|cluster|account|squad|template|microservice|service|pod|site|facility|deliverable|storefront|node|repo|repository|pipeline|client|brand|instance|database|table|application|app)s?$/i.test(cnt.unit);
          const isDownscoped = isScaleUnit && cnt.total > 0 && cnt.total <= maxAllowed;
          if (!allowedForUnit.has(cnt.total) && !isDownscoped) {
            violations.push({
              code: VIOLATION_CODES.METRIC_INFLATION,
              detected: cnt.raw,
              details: `Scale metric "${cnt.raw}" (${cnt.total} ${cnt.unit}) does not match verified baseline [${[...allowedForUnit].join(', ')}]`
            });
            violations.push({
              code: VIOLATION_CODES.SCOPE_INFLATION,
              detected: cnt.raw,
              details: `Scale metric "${cnt.raw}" (${cnt.total} ${cnt.unit}) does not match verified baseline [${[...allowedForUnit].join(', ')}]`
            });
          }
        } else {
          violations.push({
            code: VIOLATION_CODES.METRIC_INFLATION,
            detected: cnt.raw,
            details: `Count metric "${cnt.raw}" (${cnt.total} ${cnt.unit}) is not supported by verified claims`
          });
          violations.push({
            code: VIOLATION_CODES.UNTAGGED_METRIC,
            detected: cnt.raw,
            details: `Untagged count metric "${cnt.raw}" absent from candidate dossier`
          });
          violations.push({
            code: VIOLATION_CODES.SCOPE_INFLATION,
            detected: cnt.raw,
            details: `Unverified count "${cnt.raw}" exceeds verified scope`
          });
        }
      }
    }

    // Universal Numeric Token Verification:
    // Every numeric token in sentence must equal an allowed number for this employer/claim context
    const allowedNumbers = new Set();
    let targetClaims = [];
    let targetEmps = [];

    if (claimIds && claimIds.length > 0) {
      targetClaims = confirmedClaims.filter(c => claimIds.includes(c.id));
      targetEmps = employers.filter(e => targetClaims.some(c => c.employerId === e.id));
    } else {
      for (const emp of employers) {
        const re = new RegExp(`\\b${escapeRegExp(emp.name)}\\b`, 'i');
        if (re.test(text)) {
          targetEmps.push(emp);
        }
      }
      if (targetEmps.length > 0) {
        targetClaims = confirmedClaims.filter(c => targetEmps.some(e => e.id === c.employerId));
      } else {
        targetClaims = confirmedClaims;
        targetEmps = employers;
      }
    }

    for (const clm of targetClaims) {
      const allText = `${clm.text}. ${(clm.metrics || []).join('. ')}. ${(clm.details || '')}`;
      const numTokens = extractNumericTokens(allText);
      for (const nt of numTokens) allowedNumbers.add(nt.val);
      const ent = extractEntities(allText);
      for (const curr of ent.currencies) {
        allowedNumbers.add(curr.amount);
        if (curr.rawNum) allowedNumbers.add(curr.rawNum);
        if (curr.amount >= 1000 && curr.amount % 1000 === 0) allowedNumbers.add(curr.amount / 1000);
        if (curr.amount >= 1e6 && curr.amount % 1e6 === 0) allowedNumbers.add(curr.amount / 1e6);
      }
      for (const tp of ent.throughputs) {
        allowedNumbers.add(tp.rate);
        if (tp.rate >= 1000 && tp.rate % 1000 === 0) allowedNumbers.add(tp.rate / 1000);
      }
      for (const cnt of ent.counts) {
        // Exact claimed numbers only. Unit-scoped down-scoping is handled
        // separately via allowedCountsByUnit; a blanket 1..total range here
        // would spuriously allow any bare number in any context.
        allowedNumbers.add(cnt.total);
      }
      for (const pct of ent.percentages) {
        allowedNumbers.add(pct.value);
      }
      for (const lat of ent.latencies) {
        allowedNumbers.add(lat.msVal);
        allowedNumbers.add(lat.rawVal);
      }
    }

    const currentYear = new Date().getFullYear();
    for (const emp of targetEmps) {
      if (emp.startYear) {
        allowedNumbers.add(emp.startYear);
        const endY = emp.endYear || currentYear;
        allowedNumbers.add(endY);
        for (let y = emp.startYear; y <= endY; y++) allowedNumbers.add(y);
        const tenure = endY - emp.startYear + 1;
        for (let t = 1; t <= tenure; t++) allowedNumbers.add(t);
      }
    }

    if (startYears.length > 0) {
      const earliest = Math.min(...startYears);
      const maxCareerYears = currentYear - earliest + 1;
      for (let y = 1; y <= maxCareerYears; y++) allowedNumbers.add(y);
    }

    for (const d of dossier.degrees || []) if (d.year) allowedNumbers.add(d.year);
    for (const c of dossier.certifications || []) if (c.year) allowedNumbers.add(c.year);

    if (dossier.candidate && dossier.candidate.salaryFloor) {
      const sf = dossier.candidate.salaryFloor;
      if (sf.minimumBase) {
        allowedNumbers.add(sf.minimumBase);
        allowedNumbers.add(sf.minimumBase / 1000);
      }
      if (sf.targetTotal) {
        allowedNumbers.add(sf.targetTotal);
        allowedNumbers.add(sf.targetTotal / 1000);
      }
    }

    const draftNumericTokens = extractNumericTokens(text);
    for (const dnt of draftNumericTokens) {
      if (!allowedNumbers.has(dnt.val)) {
        const isDownscopedCount = draftEntities.counts.some(cnt => {
          if (cnt.isHeadcount) return false;
          let allowedForUnit = allowedCountsByUnit[cnt.baseUnit] || allowedCountsByUnit[cnt.unit];
          if (cnt.baseUnit === 'microservice' || cnt.baseUnit === 'service') {
            const sSet = allowedCountsByUnit['service'];
            const msSet = allowedCountsByUnit['microservice'];
            if (sSet || msSet) {
              allowedForUnit = new Set([...(sSet || []), ...(msSet || [])]);
            }
          }
          if (!allowedForUnit) return false;
          const maxAllowed = Math.max(...allowedForUnit);
          const isScaleUnit = /^(project|cluster|account|squad|template|microservice|service|pod|site|facility|deliverable|storefront|node|repo|repository|pipeline|client|brand|instance|database|table|application|app)$/i.test(cnt.baseUnit) ||
            /^(project|cluster|account|squad|template|microservice|service|pod|site|facility|deliverable|storefront|node|repo|repository|pipeline|client|brand|instance|database|table|application|app)s?$/i.test(cnt.unit);
          return isScaleUnit && cnt.total === dnt.val && dnt.val > 0 && dnt.val <= maxAllowed;
        });

        const isDownscopedHeadcount = draftEntities.headcounts.some(hc => {
          return hc.count === dnt.val && dnt.val > 0 && dnt.val <= maxVerifiedHeadcount;
        });

        if (isDownscopedCount || isDownscopedHeadcount) {
          continue;
        }

        violations.push({
          code: VIOLATION_CODES.METRIC_INFLATION,
          detected: dnt.raw,
          details: `Numeric quantity "${dnt.raw}" (${dnt.val}) in draft is not supported by verified claims`
        });
      }
    }

    // Comparative Before/After Values Verification
    const draftComparatives = extractComparatives(normText);
    for (const dc of draftComparatives) {
      const normB = normalizeCompValue(dc.before);
      const normA = normalizeCompValue(dc.after);

      const exactMatch = verifiedComparatives.some(vc => vc.normBefore === normB && vc.normAfter === normA);
      if (!exactMatch) {
        const matchingBefore = verifiedComparatives.find(vc => vc.normBefore === normB);
        const matchingAfter = verifiedComparatives.find(vc => vc.normAfter === normA);

        if (matchingBefore && !matchingAfter) {
          violations.push({
            code: VIOLATION_CODES.METRIC_INFLATION,
            detected: dc.raw,
            details: `Comparative metric ending value altered: verified "${matchingBefore.before} to ${matchingBefore.after}" but draft asserts "${dc.before} to ${dc.after}"`
          });
          violations.push({
            code: VIOLATION_CODES.UNTAGGED_METRIC,
            detected: dc.raw,
            details: `Altered comparative transformation target "${dc.after}"`
          });
        } else if (matchingAfter && !matchingBefore) {
          violations.push({
            code: VIOLATION_CODES.METRIC_INFLATION,
            detected: dc.raw,
            details: `Comparative metric starting value altered: verified "${matchingAfter.before} to ${matchingAfter.after}" but draft asserts "${dc.before} to ${dc.after}"`
          });
          violations.push({
            code: VIOLATION_CODES.UNTAGGED_METRIC,
            detected: dc.raw,
            details: `Altered comparative transformation baseline "${dc.before}"`
          });
        } else {
          violations.push({
            code: VIOLATION_CODES.METRIC_INFLATION,
            detected: dc.raw,
            details: `Comparative claim "${dc.raw}" is not supported by verified claims`
          });
          violations.push({
            code: VIOLATION_CODES.UNTAGGED_METRIC,
            detected: dc.raw,
            details: `Unverified comparative transformation "${dc.raw}"`
          });
        }
      }
    }

    // 7. Cross-Employer Transplant Check
    // Seed phrases kept for backwards compatibility; distinctive phrases are
    // primarily derived from dossier claim text/tools (extractClaimPhrases).
    const SEED_PHRASE_PATTERNS = [
      /payment gateway(?:\s+ledger)?/i,
      /billing (?:system|engine|migration)/i,
      /distributed tracing/i,
      /telemetry (?:ingestion|streaming)/i,
      /fuzzing(?: and regression)?/i,
      /service mesh/i,
      /zero-trust/i,
      /mobile checkout/i,
      /inventory reservation/i,
      /Core Web Vitals/i,
      /design system/i,
      /cloud compute and storage/i,
      /spot fleet/i,
      /annual (?:operating )?budget/i,
      /architecture review/i
    ];
    // Phrase frequency across employers: a phrase is distinctive only when it
    // appears under exactly one employer.
    const phraseEmployers = new Map();
    for (const clm of claims) {
      for (const phrase of extractClaimPhrases(clm)) {
        if (!phraseEmployers.has(phrase)) phraseEmployers.set(phrase, new Set());
        phraseEmployers.get(phrase).add(clm.employerId);
      }
    }
    const claimSignatures = claims.map(clm => {
      const allText = `${clm.text} ${(clm.metrics || []).join(' ')}`;
      const ent = extractEntities(allText);
      const keyPhrases = [];
      for (const pat of SEED_PHRASE_PATTERNS) {
        if (pat.test(clm.text)) keyPhrases.push(pat);
      }
      for (const phrase of extractClaimPhrases(clm)) {
        const emps = phraseEmployers.get(phrase);
        if (emps && emps.size === 1) {
          const re = phraseToRegExp(phrase);
          if (re) keyPhrases.push(re);
        }
      }
      return {
        id: clm.id,
        employerId: clm.employerId,
        currencies: ent.currencies.map(c => ({ amount: c.amount, currency: c.currency })),
        throughputs: ent.throughputs.map(t => t.rate),
        latencies: ent.latencies.map(l => l.msVal),
        percentages: ent.percentages.map(p => p.value),
        counts: ent.counts.map(c => ({ total: c.total, unit: c.unit })),
        keyPhrases
      };
    });

    for (const emp of employers) {
      const empRegex = new RegExp(`\\b${escapeRegExp(emp.name)}\\b`, 'i');
      if (empRegex.test(text)) {
        if (claimIds && claimIds.length > 0) {
          const referencedClaims = claims.filter(c => claimIds.includes(c.id));
          const mismatch = referencedClaims.some(c => c.employerId !== emp.id);
          if (mismatch) {
            violations.push({
              code: VIOLATION_CODES.TRANSPLANTED_EMPLOYER,
              employer: emp.name,
              details: `Fact is attributed to ${emp.name} but belongs to a different employer`
            });
          }
        } else {
          // Dynamic signature matching across claims
          const empSignatures = claimSignatures.filter(cs => cs.employerId === emp.id);
          const otherSignatures = claimSignatures.filter(cs => cs.employerId !== emp.id);

          for (const otherClm of otherSignatures) {
            let matchesSignature = false;

            // Check distinctive currencies
            for (const curr of otherClm.currencies) {
              if (draftEntities.currencies.some(dc => dc.amount === curr.amount)) {
                const empHasIt = empSignatures.some(es => es.currencies.some(c => c.amount === curr.amount));
                if (!empHasIt) {
                  matchesSignature = true;
                  break;
                }
              }
            }

            // Check distinctive throughputs
            if (!matchesSignature) {
              for (const tp of otherClm.throughputs) {
                if (draftEntities.throughputs.some(dt => dt.rate === tp)) {
                  const empHasIt = empSignatures.some(es => es.throughputs.some(t => t === tp));
                  if (!empHasIt) {
                    matchesSignature = true;
                    break;
                  }
                }
              }
            }

            // Check distinctive latencies
            if (!matchesSignature) {
              for (const lat of otherClm.latencies) {
                if (draftEntities.latencies.some(dl => dl.msVal === lat)) {
                  const empHasIt = empSignatures.some(es => es.latencies.some(l => l === lat));
                  if (!empHasIt) {
                    matchesSignature = true;
                    break;
                  }
                }
              }
            }

            // Check distinctive counts
            if (!matchesSignature) {
              for (const cnt of otherClm.counts) {
                if (draftEntities.counts.some(dc => dc.total === cnt.total && dc.unit === cnt.unit)) {
                  const empHasIt = empSignatures.some(es => es.counts.some(c => c.total === cnt.total && c.unit === cnt.unit));
                  if (!empHasIt) {
                    matchesSignature = true;
                    break;
                  }
                }
              }
            }

            // Check distinctive percentages
            if (!matchesSignature) {
              for (const pct of otherClm.percentages) {
                if (draftEntities.percentages.some(dp => dp.value === pct)) {
                  const empHasIt = empSignatures.some(es => es.percentages.some(p => p === pct));
                  if (!empHasIt) {
                    matchesSignature = true;
                    break;
                  }
                }
              }
            }

            // Check distinctive key project phrases
            if (!matchesSignature) {
              for (const phrasePat of otherClm.keyPhrases) {
                if (phrasePat.test(text)) {
                  const empHasIt = empSignatures.some(es => es.keyPhrases.some(kp => kp.source === phrasePat.source));
                  if (!empHasIt) {
                    matchesSignature = true;
                    break;
                  }
                }
              }
            }

            if (matchesSignature) {
              violations.push({
                code: VIOLATION_CODES.TRANSPLANTED_EMPLOYER,
                employer: emp.name,
                details: `Fact from claim ${otherClm.id} (${otherClm.employerId}) was transplanted to ${emp.name}`
              });
              break;
            }
          }
        }
      }
    }

    // 8. Unknown Employer Check
    // Sentence-initial "At Globex, I led ..." counts too (capitalised prefix).
    const employerOrgRegex = /\b(?:[Aa]t|[Ww]hile at|[Ee]mployed at|[Tt]enure at)\s+([A-Z][A-Za-z0-9&.'-]+(?:\s+[A-Z][A-Za-z0-9&.'-]+)*)/g;
    let empOrgMatch;
    while ((empOrgMatch = employerOrgRegex.exec(text)) !== null) {
      let orgName = empOrgMatch[1].trim();
      const STOP_WORDS = new Set(['I', 'We', 'They', 'He', 'She', 'My', 'Our', 'The', 'And', 'Where', 'When', 'While', 'As', 'In', 'During', 'Is', 'Was', 'Over']);
      const words = orgName.split(/\s+/);
      while (words.length > 1 && STOP_WORDS.has(words[words.length - 1])) {
        words.pop();
      }
      orgName = words.join(' ').replace(/[,.;:!]+$/, '').trim();

      const isKnown = employers.some(e => {
        const normE = e.name.toLowerCase().trim();
        const normO = orgName.toLowerCase().trim();
        return normE === normO || normE.includes(normO) || normO.includes(normE);
      });

      if (!isKnown) {
        const normO = orgName.toLowerCase();
        const isInst = [...candidateInstitutions].some(ci => ci.includes(normO) || normO.includes(ci)) ||
                       ['insead', 'harvard', 'stanford', 'mit', 'wharton', 'oxford', 'cambridge'].some(di => normO.includes(di));
        const isTool = candidateTools.has(normO) || TECH_CATALOG.some(t => {
          if (t.name === normO) return true;
          if (t.name.length >= 3) {
            const escaped = t.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            return new RegExp(`(^|\\W)${escaped}(\\W|$)`, 'i').test(normO);
          }
          return false;
        });
        const isCert = [...candidateCerts].some(cc => cc.includes(normO)) || CREDENTIAL_CATALOG.some(c => normO.includes(c.name.toLowerCase()));
        const isLocation = KNOWN_PLACES.test(normO);
        // The vacancy's own company, and NEOM (a place that is also an employer),
        // are known where the sentence applies to or is located at them — a
        // plain "at", never "while at / employed at / tenure at".
        const isTargetCompany = targetCompany.length >= 2 && normO.length >= 2 &&
          (new RegExp(`(?:^|\\W)${escapeRegExp(normO)}(?:\\W|$)`).test(targetCompany) ||
           new RegExp(`(?:^|\\W)${escapeRegExp(targetCompany)}(?:\\W|$)`).test(normO));
        const isAppliedToOrLocatedAt = (isTargetCompany || normO === 'neom') &&
          /^at\s/i.test(empOrgMatch[0]) &&
          isApplicationOrLocationContext(text.slice(0, empOrgMatch.index));

        if (!isInst && !isTool && !isCert && !isLocation && !isAppliedToOrLocatedAt) {
          violations.push({
            code: VIOLATION_CODES.UNKNOWN_EMPLOYER,
            employer: orgName,
            details: `Claimed employment or role at unverified organization "${orgName}"`
          });
        }
      }
    }

    // 9. Authorship & Scope Inflation Check
    if (/\b(sole creator|single-handed author|sole author)\b/i.test(text)) {
      violations.push({
        code: VIOLATION_CODES.AUTHORSHIP_INFLATION,
        details: 'Unverified sole authorship or creator claim'
      });
    }

    if (/\b(?:Chief Technology Officer|CTO)\b/i.test(text) &&
        (!dossier.candidate || !/chief technology officer|cto/i.test(dossier.candidate.currentTitle || ''))) {
      if (!violations.some(v => v.code === VIOLATION_CODES.SCOPE_INFLATION)) {
        violations.push({
          code: VIOLATION_CODES.SCOPE_INFLATION,
          details: 'Unverified executive title (CTO)'
        });
      }
    }

    // Title Inflation Check
    function checkTitleInflation(claimedTitleRaw, empOrgRaw) {
      if (!claimedTitleRaw || !empOrgRaw) return;
      let claimedTitle = claimedTitleRaw.trim();
      let empOrg = empOrgRaw.trim().replace(/[,.;:!]+$/, '');

      claimedTitle = claimedTitle.replace(/^(?:i\s+was|was|promoted\s+to|at|for|with|the)\s+/i, '').trim();
      claimedTitle = claimedTitle.replace(/\s+(?:overseeing|leading|directing|managing|guiding)\b.*$/i, '').trim();
      if (!claimedTitle || !empOrg) return;

      const matchedEmp = employers.find(e => {
        const normE = e.name.toLowerCase().trim();
        const normO = empOrg.toLowerCase().trim();
        return normE === normO || normE.includes(normO) || normO.includes(normE);
      });

      if (matchedEmp) {
        const verifiedTitle = (matchedEmp.title || matchedEmp.role || '').trim();
        if (claimedTitle.toLowerCase() !== verifiedTitle.toLowerCase()) {
          const cRank = getTitleSeniority(claimedTitle);
          const vRank = getTitleSeniority(verifiedTitle);
          const hasSeniorPrefix = /\b(?:chief|vp|vice president|head of|director|principal)\b/i.test(claimedTitle);
          const verifiedHasPrefix = /\b(?:chief|vp|vice president|head of|director|principal)\b/i.test(verifiedTitle);

          if (cRank > vRank || (hasSeniorPrefix && !verifiedHasPrefix)) {
            const alreadyReported = violations.some(v =>
              v.code === VIOLATION_CODES.SCOPE_INFLATION &&
              v.employer === matchedEmp.name
            );
            if (!alreadyReported) {
              violations.push({
                code: VIOLATION_CODES.SCOPE_INFLATION,
                details: `Claimed title "${claimedTitle}" exceeds verified title "${verifiedTitle}" at ${matchedEmp.name}`,
                claimedTitle,
                verifiedTitle,
                employer: matchedEmp.name
              });
              violations.push({
                code: VIOLATION_CODES.ROLE_INFLATION,
                details: `Claimed title "${claimedTitle}" exceeds verified title "${verifiedTitle}" at ${matchedEmp.name}`,
                claimedTitle,
                verifiedTitle,
                employer: matchedEmp.name
              });
              violations.push({
                code: VIOLATION_CODES.TITLE_INFLATION,
                details: `Claimed title "${claimedTitle}" exceeds verified title "${verifiedTitle}" at ${matchedEmp.name}`,
                claimedTitle,
                verifiedTitle,
                employer: matchedEmp.name
              });
            }
          }
        }
      }
    }

    // Pattern 1: Verb prefixes (served as, worked as, promoted to, was, i was, as, etc.)
    const titleRegex = /\b(?:promoted to|served as|appointed as|worked as|functioned as|role as|acted as|held the role of|held the title of|i was|was|as)\s+(?:the\s+)?([A-Za-z\s/&-]+?)\s+(?:at|for|with)\s+([A-Z][A-Za-z0-9&.'-]+(?:\s+[A-Z][A-Za-z0-9&.'-]+)*)/gi;
    let tMatch;
    while ((tMatch = titleRegex.exec(text)) !== null) {
      checkTitleInflation(tMatch[1], tMatch[2]);
    }

    // Pattern 2: "At [Employer], served as [Title]" / "At [Employer], worked as [Title]"
    const atEmpTitleRegex = /\b(?:at|for|with)\s+([A-Z][A-Za-z0-9&.'-]+(?:\s+[A-Z][A-Za-z0-9&.'-]+)*)[,\s]+(?:served as|worked as|acted as|functioned as|role as|appointed as|promoted to|held the role of|held the title of|i was|was|as)\s+(?:the\s+)?([A-Za-z\s/&-]+?)(?:[,.;]|\s+(?:overseeing|leading|directing|managing|guiding)\b|$)/gi;
    while ((tMatch = atEmpTitleRegex.exec(text)) !== null) {
      checkTitleInflation(tMatch[2], tMatch[1]);
    }

    // Pattern 3: Fronted titles: "[Title] at [Employer], ..."
    const frontedTitleRegex = /(?:^|[\n\r.!?]\s*)(?:the\s+)?([A-Z][A-Za-z0-9/&-]+(?:\s+[A-Za-z0-9/&-]+){0,5})\s+(?:at|for|with)\s+([A-Z][A-Za-z0-9&.'-]+(?:\s+[A-Z][A-Za-z0-9&.'-]+)*)(?:[,\s]+|[.!?]|$)/gi;
    while ((tMatch = frontedTitleRegex.exec(text)) !== null) {
      const candidateTitle = tMatch[1].trim();
      if (getTitleSeniority(candidateTitle) > 0 || /\b(?:chief|vp|vice president|head of|director|principal|staff|lead|senior|architect|engineer|manager|consultant|developer|specialist|analyst|administrator)\b/i.test(candidateTitle)) {
        checkTitleInflation(candidateTitle, tMatch[2]);
      }
    }

    // 8. Credentials Verification
    for (const cred of CREDENTIAL_CATALOG) {
      if (cred.regex.test(text)) {
        const isVerified = [...candidateCerts].some(cc =>
          cc.includes(cred.name.toLowerCase()) || cred.name.toLowerCase().includes(cc)
        );
        if (!isVerified) {
          violations.push({
            code: VIOLATION_CODES.FABRICATED_CREDENTIAL,
            details: `Hallucinated certification: ${cred.name}`
          });
        }
      }
    }

    // 9. Degrees & Higher Institutions Verification
    const degreeInstitutions = ['insead', 'harvard', 'stanford', 'mit', 'wharton', 'oxford'];
    for (const inst of degreeInstitutions) {
      const instRegex = new RegExp(`\\b${inst}\\b`, 'i');
      if (instRegex.test(text) && !candidateInstitutions.has(inst)) {
        violations.push({
          code: VIOLATION_CODES.FABRICATED_DEGREE,
          details: `Unverified academic institution "${inst}"`
        });
      }
    }

    if (/\bExecutive MBA\b|\bMBA\b/i.test(text) && !candidateDegrees.has('mba')) {
      if (!violations.some(v => v.code === VIOLATION_CODES.FABRICATED_DEGREE)) {
        violations.push({
          code: VIOLATION_CODES.FABRICATED_DEGREE,
          details: 'Hallucinated MBA degree not present in dossier'
        });
      }
    }

    if (/\bMaster of Science in\b/i.test(text) && !candidateDegrees.has('m.sc')) {
      if (!violations.some(v => v.code === VIOLATION_CODES.FABRICATED_DEGREE)) {
        violations.push({
          code: VIOLATION_CODES.FABRICATED_DEGREE,
          details: 'Hallucinated Master of Science degree not present in dossier'
        });
      }
    }

    // 10. Celebrity Endorsements Verification
    const endorsementMatch = text.match(/\b(?:personally\s+)?(?:praised|commended|personally commended|endorsed|recognized)\s+by\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/i);
    if (endorsementMatch) {
      const celebrity = endorsementMatch[1].trim();
      const allowedEndorsements = (dossier.endorsements || []).map(e => (typeof e === 'string' ? e : e.author || '').toLowerCase());
      if (!allowedEndorsements.some(e => e.includes(celebrity.toLowerCase()))) {
        violations.push({
          code: VIOLATION_CODES.FABRICATED_ENDORSEMENT,
          details: `Fabricated celebrity endorsement by "${celebrity}"`
        });
      }
    }

    // 11. Awards & Accolades Verification
    const awardMatch = text.match(/\b(Forbes\s+30\s+Under\s+30|Turing\s+Award|ACM\s+Turing\s+Award|Top\s+40\s+Under\s+40|Nobel\s+Prize)\b/i);
    if (awardMatch) {
      const awardName = awardMatch[1].trim();
      const allowedAwards = (dossier.awards || []).map(a => (typeof a === 'string' ? a : a.name || '').toLowerCase());
      if (!allowedAwards.some(a => a.includes(awardName.toLowerCase()))) {
        violations.push({
          code: VIOLATION_CODES.FABRICATED_AWARD,
          details: `Fabricated accolade or award: "${awardName}"`
        });
      }
    }

    // 12. Patents Verification (singular patent or plural patents)
    if (/\bpatents?\b|\bpatented\b/i.test(text) && (!dossier.patents || dossier.patents.length === 0)) {
      if (/invented and patented/i.test(text)) {
        violations.push({
          code: VIOLATION_CODES.AUTHORSHIP_INFLATION,
          details: 'Unverified claim of inventing and patenting core protocol'
        });
      } else {
        violations.push({
          code: VIOLATION_CODES.FABRICATED_PATENT,
          details: 'Candidate claims patents when zero patents are documented in dossier'
        });
      }
    }

    // 13. Unconfirmed-claim gate: a sentence may not cite or rely on a claim the
    // candidate has not confirmed. Its figures are already absent from the
    // baselines above; this names the claim so the user knows what to confirm.
    if (unconfirmedClaims.length > 0) {
      const contentTokens = (s) => new Set(String(s || '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/)
        .filter(w => w.length > 3 && !/^\d+$/.test(w) && !PHRASE_STOPWORDS.has(w)));
      const sentenceTokens = contentTokens(text);
      const overlap = (clm) => [...contentTokens(clm.text)].filter(w => sentenceTokens.has(w)).length;
      const bestConfirmedOverlap = Math.max(0, ...confirmedClaims.map(overlap));
      const unsupportedNumbers = [
        ...draftNumericTokens.map(t => t.val).filter(n => !allowedNumbers.has(n)),
        ...draftEntities.latencies.map(l => l.msVal).filter(n => !allowedLatenciesMs.has(n))
      ];

      for (const clm of unconfirmedClaims) {
        const id = String(clm.id || '');
        const claimText = `${clm.text}. ${(clm.metrics || []).join('. ')}.`;
        // "[C-01]" always counts as a citation; a bare id only when it has the tag shape.
        const tagPattern = /^[A-Za-z][A-Za-z0-9]*-\d/.test(id)
          ? `(?<![\\w-])${escapeRegExp(id)}(?![\\w-])`
          : `\\[\\s*${escapeRegExp(id)}\\s*\\]`;
        let reason = null;
        if (!options.citationsChecked && claimIds.includes(clm.id)) {
          reason = 'is cited';
        } else if (id && new RegExp(tagPattern, 'i').test(text)) {
          reason = 'is cited';
        } else {
          const claimNumbers = new Set([
            ...extractNumericTokens(claimText).map(t => t.val),
            ...extractEntities(claimText).latencies.map(l => l.msVal)
          ]);
          const usedNumber = unsupportedNumbers.find(n => claimNumbers.has(n));
          const shared = overlap(clm);
          if (usedNumber !== undefined) {
            reason = `supplies the figure ${usedNumber}`;
          } else if (shared >= 3 && shared >= contentTokens(clm.text).size / 2 && shared > bestConfirmedOverlap) {
            reason = 'is restated';
          }
        }
        if (reason) {
          violations.push({
            code: VIOLATION_CODES.UNVERIFIED_CLAIM,
            claimId: clm.id,
            details: `Claim "${id}" ${reason} but is not confirmed (status ${clm.status}) — confirm it in the dossier before using it`
          });
        }
      }
    }

    // Deduplicate violations by code and details
    const uniqueViolations = [];
    const seen = new Set();
    for (const v of violations) {
      const key = `${v.code}:${v.details}`;
      if (!seen.has(key)) {
        seen.add(key);
        uniqueViolations.push(v);
      }
    }

    return {
      passed: uniqueViolations.length === 0,
      violations: uniqueViolations
    };
  }

  /**
   * Verifies an entire draft document against a candidate dossier.
   * @param {Object} dossier Candidate dossier
   * @param {string} draftText Draft text
   * @param {Object} options
   * @param {string[]} [options.claimIds] Claims the draft is built on
   * @param {string} [options.targetCompany] Company of the vacancy the draft is written for
   */
  static verifyDraft(dossier, draftText, options = {}) {
    const rawLines = draftText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const violations = [];
    const sentenceResults = [];
    const claimIds = options.claimIds || [];

    // Every claim the draft is declared to be built on must be confirmed
    // (reported once for the draft, not once per sentence).
    for (const clm of dossier.claims || []) {
      if (!isConfirmedClaim(clm) && claimIds.includes(clm.id)) {
        violations.push({
          code: VIOLATION_CODES.UNVERIFIED_CLAIM,
          claimId: clm.id,
          details: `Claim "${clm.id}" is cited but is not confirmed (status ${clm.status}) — confirm it in the dossier before using it`,
          sentenceIndex: 0,
          sentence: ''
        });
      }
    }

    let sentenceIndex = 0;
    for (const line of rawLines) {
      const sentences = splitSentences(line);

      for (const sentence of sentences) {
        sentenceIndex++;
        const res = ClaimVerifier.verifySentence({ draftText: sentence, claimIds }, dossier,
          { targetCompany: options.targetCompany, citationsChecked: true });
        if (!res.passed) {
          for (const v of res.violations) {
            violations.push({
              ...v,
              sentenceIndex,
              sentence
            });
          }
        }
        sentenceResults.push({
          sentenceIndex,
          sentence,
          passed: res.passed,
          violations: res.violations
        });
      }
    }

    const uniqueCodes = [...new Set(violations.map(v => v.code))];

    return {
      passed: violations.length === 0,
      timestamp: new Date().toISOString(),
      dossier: {
        candidate: dossier.candidate ? dossier.candidate.name : 'Unknown',
        verifiedClaimsCount: Array.isArray(dossier.claims) ? dossier.claims.filter(c => c.status === 'VERIFIED' || !c.status).length : 0,
        employersCount: Array.isArray(dossier.employers) ? dossier.employers.length : 0
      },
      summary: {
        totalSentences: sentenceResults.length,
        cleanSentences: sentenceResults.filter(s => s.passed).length,
        violatedSentences: sentenceResults.filter(s => !s.passed).length,
        totalViolations: violations.length,
        violationCodes: uniqueCodes
      },
      violations
    };
  }
}

/**
 * Top-level verification helper.
 */
function verifyDraftAgainstDossier(dossier, draftTextOrCase, options = {}) {
  if (typeof draftTextOrCase === 'object' && draftTextOrCase !== null && draftTextOrCase.draftText) {
    return ClaimVerifier.verifySentence(draftTextOrCase, dossier, options);
  }
  const text = typeof draftTextOrCase === 'string' ? draftTextOrCase : (draftTextOrCase.content || '');
  return ClaimVerifier.verifyDraft(dossier, text, options);
}

// ============================================================================
// CLI Entry Point
// ============================================================================

async function runCli(argv = process.argv.slice(2)) {
  let dossierPath = null;
  let draftInput = null;
  let isJson = false;
  let isVerbose = false;
  let claimIds = [];
  let targetCompany;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dossier' && i + 1 < argv.length) {
      dossierPath = argv[++i];
    } else if (arg === '--draft' && i + 1 < argv.length) {
      draftInput = argv[++i];
    } else if (arg === '--claim-ids' && i + 1 < argv.length) {
      claimIds = argv[++i].split(',').map(s => s.trim());
    } else if (arg === '--company' && i + 1 < argv.length) {
      targetCompany = argv[++i];
    } else if (arg === '--json') {
      isJson = true;
    } else if (arg === '--verbose') {
      isVerbose = true;
    } else if (arg === '-h' || arg === '--help') {
      console.log(`
Usage: verify-claims --dossier <path-to-dossier.json> --draft <path-to-draft.txt|md|text> [options]

Options:
  --dossier <path>    Path to candidate dossier JSON file (required)
  --draft <path|text> Path to draft file, or plain text string (required)
  --claim-ids <ids>   Comma-separated list of claim IDs to verify against
  --company <name>    Company of the vacancy the draft is written for
  --json              Output verification result as machine-readable JSON
  --verbose           Display detailed breakdown
  -h, --help          Show help message
`);
      process.exit(0);
    }
  }

  if (!dossierPath || !draftInput) {
    if (isJson) {
      console.log(JSON.stringify({ passed: false, error: 'Usage error: --dossier and --draft are required' }));
    } else {
      console.error('[ERROR] Usage: verify-claims --dossier <path> --draft <path|text> [--json]');
    }
    process.exit(2);
  }

  let dossier;
  try {
    const raw = fs.readFileSync(path.resolve(dossierPath), 'utf8');
    dossier = JSON.parse(raw);
  } catch (err) {
    console.error(`[ERROR] Failed to read dossier file at ${dossierPath}: ${err.message}`);
    process.exit(2);
  }

  let draftText = draftInput;
  if (fs.existsSync(draftInput)) {
    try {
      draftText = fs.readFileSync(path.resolve(draftInput), 'utf8');
    } catch (err) {
      console.error(`[ERROR] Failed to read draft file at ${draftInput}: ${err.message}`);
      process.exit(2);
    }
  }

  const result = ClaimVerifier.verifyDraft(dossier, draftText, { claimIds, targetCompany });

  if (isJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (result.passed) {
      console.log(`[PASS] Claim verification passed (0 violations across ${result.summary.totalSentences} sentence(s))`);
    } else {
      console.log(`[FAIL] Claim verification detected ${result.violations.length} violation(s):`);
      for (const v of result.violations) {
        console.log(`  - [${v.code}] Line/Sentence ${v.sentenceIndex}: ${v.details}`);
        if (isVerbose && v.sentence) {
          console.log(`    Context: "${v.sentence}"`);
        }
      }
    }
  }

  process.exit(result.passed ? 0 : 1);
}

if (require.main === module) {
  runCli();
}

module.exports = {
  ClaimVerifier,
  verifyDraftAgainstDossier,
  extractEntities,
  splitSentences,
  extractClaimPhrases,
  VIOLATION_CODES
};
