'use strict';

/**
 * JobHunt Crew — Saudi Labor Law Offer & Contract Calculator
 *
 * Implements statutory labor law computations:
 * - 65% Basic / 25% Housing / 10% Transportation salary breakdown.
 * - GOSI contributions (21.5% for Saudi nationals; 2% occupational hazards for expats; 45k cap).
 *   Nationality defaults to non-Saudi (expatriate) unless isSaudiNational is true.
 * - Article 53 Probation validation (90-180 days statutory limits).
 * - Article 84 & 85 End-of-Service Benefits (EOSB) tenure accrual and resignation curves.
 * - Article 83 Non-compete enforceability analysis.
 *
 * @module lib/crew/ksa-offer
 */

const GOSI_WAGE_CAP = 45000; // 45,000 SAR monthly max contributory base
const QIWA_NOTICE_DAYS = 90; // Service-transfer notice window tracked for Qiwa moves
const DAY_MS = 24 * 60 * 60 * 1000;

// Roles commonly reserved for Saudi nationals under localization decisions.
// Titles are matched loosely in English and Arabic; this is a screening aid,
// not a legal determination for any specific vacancy.
const LOCALIZED_PROFESSIONS = [
  { id: 'hr-manager', en: 'Human Resources Manager', ar: 'مدير الموارد البشرية', aliases: ['hr manager', 'human resources manager', 'personnel manager'] },
  { id: 'recruitment-officer', en: 'Recruitment Officer', ar: 'أخصائي توظيف', aliases: ['recruitment officer', 'recruitment specialist', 'employment officer'] },
  { id: 'receptionist', en: 'Receptionist', ar: 'موظف استقبال', aliases: ['receptionist', 'front desk officer', 'reception officer'] },
  { id: 'cashier', en: 'Cashier', ar: 'أمين صندوق', aliases: ['cashier'] },
  { id: 'security-guard', en: 'Security Guard', ar: 'حارس أمن', aliases: ['security guard', 'private security guard'] },
  { id: 'customer-service', en: 'Customer Service Representative', ar: 'ممثل خدمة عملاء', aliases: ['customer service representative', 'customer service agent', 'call center agent'] },
  { id: 'admin-assistant', en: 'Administrative Assistant', ar: 'مساعد إداري', aliases: ['administrative assistant', 'office administrator', 'data entry clerk'] },
  { id: 'tour-guide', en: 'Tour Guide', ar: 'مرشد سياحي', aliases: ['tour guide', 'tourist guide'] },
  { id: 'customs-broker', en: 'Customs Clearance Broker', ar: 'مخلص جمركي', aliases: ['customs broker', 'customs clearance agent'] },
  { id: 'real-estate-broker', en: 'Real Estate Broker', ar: 'وسيط عقاري', aliases: ['real estate broker', 'property broker'] }
];

function toAmount(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function round2(value) {
  return Number(Number(value).toFixed(2));
}

class KsaOfferCalculator {
  /**
   * Calculates statutory salary split between Basic, Housing, and Transport.
   * Standard ratio: 65% Basic / 25% Housing / 10% Transport.
   * @param {number} amount - Total monthly gross (or basic salary if isGross=false)
   * @param {Object} [options]
   * @param {boolean} [options.isGross=true]
   * @param {boolean} [options.companyHousing=false]
   * @returns {Object} Salary breakdown
   */
  static calculateSalaryStructure(amount, options = {}) {
    const isGross = options.isGross !== false;
    // An employer-stated split always wins. The 65/25/10 ratio is only a
    // fallback for components the offer does not specify.
    const split = (options.split && typeof options.split === 'object') ? options.split : options;
    const hasBasic = split.basic !== undefined && split.basic !== null;
    const hasHousing = split.housing !== undefined && split.housing !== null;
    const hasTransport = (split.transport !== undefined && split.transport !== null) ||
      (split.transportation !== undefined && split.transportation !== null);
    const hasExplicitSplit = hasBasic || hasHousing || hasTransport;

    let gross = 0;
    let basic = 0;
    let housing = 0;
    let transport = 0;
    let splitSource = 'default_ratio';
    const warnings = [];

    if (hasExplicitSplit) {
      splitSource = 'offer_stated';
      basic = hasBasic ? round2(split.basic) : 0;
      housing = hasHousing ? round2(split.housing) : 0;
      transport = hasTransport ? round2(split.transport !== undefined ? split.transport : split.transportation) : 0;
      const other = round2(split.otherAllowances || split.other || 0);
      const grossStated = amount !== undefined && amount !== null && toAmount(amount) > 0 && isGross;
      if (grossStated) {
        gross = round2(amount);
      } else if (amount !== undefined && amount !== null && toAmount(amount) > 0 && !hasBasic) {
        basic = round2(amount);
        gross = round2(basic + housing + transport + other);
      } else {
        gross = round2(basic + housing + transport + other);
      }
      // With a stated gross, unspecified components share what is left of it after
      // the stated ones, in the standard 65/25/10 proportions, so the parts never
      // exceed gross. Without a stated gross, unspecified components stay 0.
      const missing = !grossStated ? [] : [
        !hasBasic && ['basic', 0.65],
        !hasHousing && ['housing', 0.25],
        !hasTransport && ['transport', 0.10]
      ].filter(Boolean);
      const remainder = round2(gross - basic - housing - transport - other);
      if (remainder < 0) {
        warnings.push({
          code: 'COMPONENTS_EXCEED_GROSS',
          message: `Stated components exceed the stated gross by ${round2(-remainder)} SAR. Confirm the figures with the employer.`
        });
      } else if (missing.length > 0) {
        const weight = missing.reduce((sum, [, w]) => sum + w, 0);
        const filled = { basic, housing, transport };
        let left = remainder;
        missing.forEach(([key, w], i) => {
          // The last missing component takes the rest so rounding never drifts from gross.
          filled[key] = i === missing.length - 1 ? round2(left) : round2(remainder * w / weight);
          left -= filled[key];
        });
        ({ basic, housing, transport } = filled);
      }
    } else if (amount && typeof amount === 'object') {
      return KsaOfferCalculator.calculateSalaryStructure(amount.gross || amount.totalSalary || 0, {
        ...options,
        split: amount
      });
    } else if (isGross) {
      gross = Number(amount);
      basic = Number((gross * 0.65).toFixed(2));
      housing = Number((gross * 0.25).toFixed(2));
      transport = Number((gross * 0.10).toFixed(2));
    } else {
      basic = Number(amount);
      gross = Number((basic / 0.65).toFixed(2));
      housing = Number((gross * 0.25).toFixed(2));
      transport = Number((gross * 0.10).toFixed(2));
    }

    const basicShare = gross > 0 ? Number((basic / gross).toFixed(4)) : 0;
    if (gross > 0 && basicShare < 0.50) {
      warnings.push({
        code: 'PREDATORY_BASIC_COMPRESSION',
        basicShare,
        message: 'Basic salary is under 50% of total package, which depresses statutory End-of-Service benefits.'
      });
    }
    // KSA market norm: housing allowance of 25% of BASIC (three months' basic per year).
    if (gross > 0 && housing < round2(basic * 0.25) && !options.companyHousing) {
      warnings.push({
        code: 'SUBSTANDARD_HOUSING_ALLOWANCE',
        message: 'Housing allowance is below the market norm of 25% of basic salary (three months of basic per year) without company-provided accommodation.'
      });
    }

    return {
      gross,
      basic,
      housing,
      transport,
      basicShare,
      splitSource,
      warnings
    };
  }

  /**
   * Calculates GOSI social insurance contributions.
   * Contributory wage = Basic + Housing (capped at 45,000 SAR).
   * @param {number|Object} wage - Contributory wage or split object { basic, housing }
   * @param {boolean} [isSaudiNational=false] Only true selects the Saudi-national rates
   * @returns {Object} GOSI assessment
   */
  static calculateGosi(wage, isSaudiNational = false) {
    let contributoryWage = 0;
    if (typeof wage === 'number') {
      contributoryWage = wage;
    } else if (wage && typeof wage === 'object') {
      contributoryWage = (Number(wage.basic) || 0) + (Number(wage.housing) || 0);
    }

    const cappedWage = Math.min(contributoryWage, GOSI_WAGE_CAP);

    if (isSaudiNational === true) {
      // Saudi National:
      // Annuities: 9% employee, 9% employer
      // SANED: 0.75% employee, 0.75% employer
      // Hazards: 0% employee, 2% employer
      const employeeRate = 0.0975;
      const employerRate = 0.1175;
      const totalRate = 0.215;

      const employeeDeduction = Number((cappedWage * employeeRate).toFixed(2));
      const employerContribution = Number((cappedWage * employerRate).toFixed(2));
      const totalContribution = Number((cappedWage * totalRate).toFixed(2));

      return {
        contributoryWage,
        cappedContributoryWage: cappedWage,
        isCapped: contributoryWage > GOSI_WAGE_CAP,
        isSaudiNational: true,
        employeeRate: 0.0975,
        employeeDeduction,
        employerRate: 0.1175,
        employerContribution,
        totalGosiRate: 0.215,
        totalGosiContribution: totalContribution
      };
    } else {
      // Non-Saudi (Expatriate):
      // 0% employee, 2% employer hazards
      const employerRate = 0.02;
      const employerContribution = Number((cappedWage * employerRate).toFixed(2));

      return {
        contributoryWage,
        cappedContributoryWage: cappedWage,
        isCapped: contributoryWage > GOSI_WAGE_CAP,
        isSaudiNational: false,
        employeeRate: 0.0,
        employeeDeduction: 0,
        employerRate: 0.02,
        employerContribution,
        totalGosiRate: 0.02,
        totalGosiContribution: employerContribution
      };
    }
  }

  /**
   * Article 2 "actual wage" basis used for EOSB: basic salary plus every
   * regular, recurring allowance (housing, transport, and other regular
   * allowances). This basis is deliberately broader than the GOSI
   * contributory wage, which stays basic + housing subject to its cap.
   * @param {number|Object} wageInput - Monthly wage amount or salary split
   * @returns {Object} Actual-wage breakdown
   */
  static calculateActualWage(wageInput) {
    if (typeof wageInput === 'number' || (typeof wageInput === 'string' && wageInput.trim() !== '')) {
      const amount = round2(wageInput);
      return {
        actualWage: amount,
        basic: amount,
        housing: 0,
        transport: 0,
        regularAllowances: 0,
        basis: 'amount_supplied'
      };
    }
    const w = (wageInput && typeof wageInput === 'object') ? wageInput : {};
    const basic = round2(w.basic || 0);
    const housing = round2(w.housing || 0);
    const transport = round2(w.transport !== undefined ? w.transport : (w.transportation || 0));
    let regularAllowances = 0;
    if (Array.isArray(w.regularAllowances)) {
      regularAllowances = round2(w.regularAllowances.reduce((sum, item) => {
        if (item && typeof item === 'object') return sum + toAmount(item.amount !== undefined ? item.amount : item.value);
        return sum + toAmount(item);
      }, 0));
    } else {
      regularAllowances = round2(w.regularAllowances || w.otherRegularAllowances || w.allowances || 0);
    }
    return {
      actualWage: round2(basic + housing + transport + regularAllowances),
      basic,
      housing,
      transport,
      regularAllowances,
      basis: 'basic+housing+transport+regular_allowances'
    };
  }

  /**
   * Calculates End-of-Service Benefits (EOSB) under Articles 84 & 85.
   * Wage basis is the Article 2 actual wage (see calculateActualWage).
   * Passing a plain number keeps the historic single-amount behaviour.
   * @param {number|Object} monthlyWage - Wage amount or salary split
   * @param {number} tenureYears - Total completed service years (including pro-rata)
   * @param {string} [separationType='TERMINATION'] 'TERMINATION', 'CONTRACT_EXPIRY', or 'RESIGNATION'
   * @returns {Object} EOSB calculation
   */
  static calculateEosb(monthlyWage, tenureYears, separationType = 'TERMINATION') {
    const wageBasis = KsaOfferCalculator.calculateActualWage(monthlyWage);
    const wage = wageBasis.actualWage;
    const years = Number(tenureYears);
    const type = String(separationType).toUpperCase();

    if (isNaN(wage) || isNaN(years) || years < 0) {
      throw new Error('Invalid monthly wage or tenure years');
    }

    // Article 84: Full statutory accrual
    // Half month wage for first 5 years, full month wage for each year thereafter
    let fullAccrual = 0;
    if (years <= 5) {
      fullAccrual = years * 0.5 * wage;
    } else {
      fullAccrual = (5 * 0.5 * wage) + ((years - 5) * 1.0 * wage);
    }
    fullAccrual = Number(fullAccrual.toFixed(2));

    // Article 85: Resignation reduction multipliers
    let resignationMultiplier = 1.0;
    if (type === 'RESIGNATION') {
      if (years < 2) {
        resignationMultiplier = 0.0;
      } else if (years < 5) {
        resignationMultiplier = 1 / 3;
      } else if (years < 10) {
        resignationMultiplier = 2 / 3;
      } else {
        resignationMultiplier = 1.0;
      }
    }

    const finalAmount = Number((fullAccrual * resignationMultiplier).toFixed(2));

    return {
      monthlyWage: wage,
      actualWage: wageBasis.actualWage,
      wageBasis,
      tenureYears: years,
      separationType: type,
      fullAccrualArticle84: fullAccrual,
      resignationMultiplier: Number(resignationMultiplier.toFixed(4)),
      finalEosbAmount: finalAmount
    };
  }

  /**
   * Evaluates Article 83 non-compete clause reasonableness.
   * @param {Object} clauseTerms
   * @param {number} [clauseTerms.durationMonths] Max 24 months
   * @param {string} [clauseTerms.geographicScope] Must be defined
   * @param {string} [clauseTerms.businessActivity] Specific domain
   * @returns {Object} Enforceability assessment
   */
  static validateNonCompete(clauseTerms = {}) {
    const months = clauseTerms.durationMonths || clauseTerms.duration || 0;
    const scope = (clauseTerms.geographicScope || clauseTerms.scope || '').toLowerCase();
    const issues = [];
    const recommendations = [];

    if (months > 24) {
      issues.push(`Duration (${months} months) exceeds the statutory Article 83 limit of 24 months (2 years). It is legally void.`);
    }

    if (!scope || scope.includes('worldwide') || scope.includes('global') || scope.includes('unlimited')) {
      issues.push('Geographical scope is unbounded or global. Article 83 mandates strict restriction to locations where employer actively conducts business.');
    }

    const isValid = issues.length === 0;
    if (!isValid) {
      recommendations.push('Negotiate non-compete duration to <= 24 months and restrict geographic scope specifically to current city/province.');
    }

    return {
      isValid,
      durationMonths: months,
      geographicScope: clauseTerms.geographicScope || 'Unspecified',
      issues,
      recommendations
    };
  }

  /**
   * Tracks the 90-day Qiwa service-transfer notice window.
   * @param {Object|string|Date} input - Notice date or { noticeDate|transferRequestDate|startDate }
   * @param {string|Date} [referenceDate] - Defaults to now
   * @returns {Object} Countdown state
   */
  static qiwaTransferCountdown(input, referenceDate = new Date()) {
    const raw = (input && typeof input === 'object' && !(input instanceof Date))
      ? (input.noticeDate || input.transferRequestDate || input.requestDate || input.startDate)
      : input;
    const noticeMs = new Date(raw).getTime();
    if (Number.isNaN(noticeMs)) {
      throw new Error(`Invalid Qiwa notice date: ${raw}`);
    }
    const refMs = new Date(referenceDate).getTime();
    const eligibleMs = noticeMs + (QIWA_NOTICE_DAYS * DAY_MS);
    const daysElapsed = Math.max(0, Math.floor((refMs - noticeMs) / DAY_MS));
    const daysRemaining = Math.max(0, Math.ceil((eligibleMs - refMs) / DAY_MS));
    const eligible = refMs >= eligibleMs;
    return {
      noticeDate: new Date(noticeMs).toISOString(),
      referenceDate: new Date(refMs).toISOString(),
      noticeDays: QIWA_NOTICE_DAYS,
      earliestTransferDate: new Date(eligibleMs).toISOString(),
      daysElapsed,
      daysRemaining,
      status: eligible ? 'ELIGIBLE' : 'NOTICE_RUNNING',
      eligible
    };
  }

  static trackQiwaTransfer(input, referenceDate) {
    return KsaOfferCalculator.qiwaTransferCountdown(input, referenceDate);
  }

  /**
   * Flags titles that match the localized-professions screening list.
   * @param {string} title - Job title in English or Arabic
   * @returns {Object} Alert result
   */
  static checkLocalizedProfession(title) {
    const text = String(title || '').trim();
    const lower = text.toLowerCase();
    for (const profession of LOCALIZED_PROFESSIONS) {
      const candidates = [profession.en.toLowerCase(), ...(profession.aliases || [])];
      const matchedAlias = candidates.find(alias => lower === alias || lower.includes(alias));
      const matchedArabic = profession.ar && text.includes(profession.ar);
      if (matchedAlias || matchedArabic) {
        return {
          isLocalized: true,
          alert: 'LOCALIZED_PROFESSION',
          profession,
          matchedOn: matchedArabic ? profession.ar : matchedAlias,
          message: 'This title matches a profession commonly reserved for Saudi nationals. Confirm eligibility before investing effort.'
        };
      }
    }
    return { isLocalized: false, alert: null, profession: null, matchedOn: null, message: '' };
  }

  /**
   * Comprehensive employment offer evaluation.
   */
  static evaluateOffer(offerTerms = {}) {
    const statedSplit = {};
    if (offerTerms.basic !== undefined) statedSplit.basic = offerTerms.basic;
    if (offerTerms.housing !== undefined) statedSplit.housing = offerTerms.housing;
    if (offerTerms.transport !== undefined) statedSplit.transport = offerTerms.transport;
    if (offerTerms.transportation !== undefined) statedSplit.transport = offerTerms.transportation;
    if (offerTerms.split && typeof offerTerms.split === 'object') Object.assign(statedSplit, offerTerms.split);
    const hasStatedSplit = Object.keys(statedSplit).length > 0;

    let gross = offerTerms.totalSalary || offerTerms.gross || 0;
    // Historic single-field shape { basic } with no gross keeps deriving the
    // package from the basic salary at the standard ratio.
    const basicOnly = hasStatedSplit && Object.keys(statedSplit).length === 1 && statedSplit.basic !== undefined;
    const basicOnlyHistoric = basicOnly && !gross;
    if (basicOnlyHistoric) gross = statedSplit.basic / 0.65;
    if (!gross && !hasStatedSplit && offerTerms.basic) gross = offerTerms.basic / 0.65;
    // Other fixed allowances belong in the stated split, so the breakdown sets them
    // aside before filling missing parts. With no stated split the gross is spread
    // at the standard ratio and already contains them: adding them again would
    // count them twice in the end-of-service wage.
    const usesStatedSplit = hasStatedSplit && !basicOnlyHistoric;
    const otherAllowances = usesStatedSplit ? Math.max(0, Number(offerTerms.regularAllowances) || 0) : 0;
    const structure = usesStatedSplit
      ? KsaOfferCalculator.calculateSalaryStructure(gross || undefined, {
        split: otherAllowances ? { ...statedSplit, otherAllowances } : statedSplit,
        companyHousing: Boolean(offerTerms.companyHousing)
      })
      : KsaOfferCalculator.calculateSalaryStructure(gross);

    // Not stated means non-Saudi (expatriate): assuming a Saudi national would
    // deduct a 9.75% employee GOSI share an expatriate never pays.
    const isSaudi = offerTerms.isSaudiNational === true;
    const nationalityStated = typeof offerTerms.isSaudiNational === 'boolean';
    const nationality = {
      isSaudiNational: isSaudi,
      source: nationalityStated ? 'stated' : 'assumed_default',
      note: (isSaudi
        ? 'GOSI calculated for a Saudi national (9.75% employee deduction).'
        : 'GOSI calculated for a non-Saudi (expatriate) employee: no employee deduction.') +
        (nationalityStated ? '' : ' Nationality was not stated; set isSaudiNational to true for a Saudi national.')
    };
    const gosi = KsaOfferCalculator.calculateGosi(structure, isSaudi);

    const netMonthly = Number((structure.gross - gosi.employeeDeduction).toFixed(2));

    const probationDays = offerTerms.probationDays ?? 90; // 0 means no probation, not the default
    const probationIssues = [];
    if (probationDays > 180) {
      probationIssues.push(`Probation of ${probationDays} days violates Article 53 statutory limit of 180 days.`);
    } else if (probationDays > 90) {
      probationIssues.push(`Probation is ${probationDays} days. Article 53 requires explicit mutual written agreement to exceed 90 days.`);
    }

    // An offer with no non-compete clause has nothing to flag.
    const nonCompete = (offerTerms.nonCompeteMonths == null && !offerTerms.nonCompeteScope)
      ? { isValid: true, stated: false, issues: [], recommendations: [] }
      : KsaOfferCalculator.validateNonCompete({
        durationMonths: offerTerms.nonCompeteMonths,
        geographicScope: offerTerms.nonCompeteScope
      });

    const eosbWageBasis = KsaOfferCalculator.calculateActualWage({
      basic: structure.basic,
      housing: structure.housing,
      transport: structure.transport,
      regularAllowances: otherAllowances
    });
    const eosb = (offerTerms.tenureYears !== undefined && offerTerms.tenureYears !== null)
      ? KsaOfferCalculator.calculateEosb(eosbWageBasis, offerTerms.tenureYears, offerTerms.separationType || 'TERMINATION')
      : { actualWage: eosbWageBasis.actualWage, wageBasis: eosbWageBasis };

    let qiwaTransfer = null;
    const qiwaInput = offerTerms.qiwaNoticeDate || offerTerms.qiwaTransferRequestDate || offerTerms.transferNoticeDate;
    if (qiwaInput) {
      qiwaTransfer = KsaOfferCalculator.qiwaTransferCountdown(qiwaInput, offerTerms.referenceDate || new Date());
    }

    const localizedProfession = offerTerms.title
      ? KsaOfferCalculator.checkLocalizedProfession(offerTerms.title)
      : null;

    return {
      structure,
      nationality,
      gosi,
      eosb,
      eosbWageBasis,
      qiwaTransfer,
      localizedProfession,
      netMonthlyTakeHome: netMonthly,
      probation: {
        days: probationDays,
        valid: probationDays <= 180,
        issues: probationIssues
      },
      nonCompete,
      summary: `Gross: ${structure.gross} SAR | Net: ${netMonthly} SAR | GOSI: ${gosi.employeeDeduction} SAR (${isSaudi ? 'Saudi national' : 'non-Saudi'}${nationalityStated ? '' : ', assumed'})`
    };
  }
}

module.exports = {
  KsaOfferCalculator,
  GOSI_WAGE_CAP,
  QIWA_NOTICE_DAYS,
  LOCALIZED_PROFESSIONS
};
