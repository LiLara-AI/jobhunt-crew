'use strict';

/**
 * JobHunt Crew — Saudi Labor Law Offer & Contract Calculator
 *
 * Implements statutory labor law computations:
 * - 65% Basic / 25% Housing / 10% Transportation salary breakdown.
 * - GOSI contributions (21.5% for Saudi nationals; 2% occupational hazards for expats; 45k cap).
 * - Article 53 Probation validation (90-180 days statutory limits).
 * - Article 84 & 85 End-of-Service Benefits (EOSB) tenure accrual and resignation curves.
 * - Article 83 Non-compete enforceability analysis.
 *
 * @module lib/crew/ksa-offer
 */

const GOSI_WAGE_CAP = 45000; // 45,000 SAR monthly max contributory base

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
    let gross = 0;
    let basic = 0;
    let housing = 0;
    let transport = 0;

    if (isGross) {
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

    const warnings = [];
    if (basic / gross < 0.50) {
      warnings.push({
        code: 'PREDATORY_BASIC_COMPRESSION',
        message: 'Basic salary is under 50% of total package, which depresses statutory End-of-Service benefits.'
      });
    }
    if (housing / gross < 0.25 && !options.companyHousing) {
      warnings.push({
        code: 'SUBSTANDARD_HOUSING_ALLOWANCE',
        message: 'Housing allowance is below standard 25% without company-provided accommodation.'
      });
    }

    return {
      gross,
      basic,
      housing,
      transport,
      warnings
    };
  }

  /**
   * Calculates GOSI social insurance contributions.
   * Contributory wage = Basic + Housing (capped at 45,000 SAR).
   * @param {number|Object} wage - Contributory wage or split object { basic, housing }
   * @param {boolean} [isSaudiNational=true]
   * @returns {Object} GOSI assessment
   */
  static calculateGosi(wage, isSaudiNational = true) {
    let contributoryWage = 0;
    if (typeof wage === 'number') {
      contributoryWage = wage;
    } else if (wage && typeof wage === 'object') {
      contributoryWage = (Number(wage.basic) || 0) + (Number(wage.housing) || 0);
    }

    const cappedWage = Math.min(contributoryWage, GOSI_WAGE_CAP);

    if (isSaudiNational) {
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
   * Calculates End-of-Service Benefits (EOSB) under Articles 84 & 85.
   * Base monthly wage = Basic + Housing.
   * @param {number} monthlyWage - Last drawn monthly contributory wage (Basic + Housing)
   * @param {number} tenureYears - Total completed service years (including pro-rata)
   * @param {string} [separationType='TERMINATION'] 'TERMINATION', 'CONTRACT_EXPIRY', or 'RESIGNATION'
   * @returns {Object} EOSB calculation
   */
  static calculateEosb(monthlyWage, tenureYears, separationType = 'TERMINATION') {
    const wage = Number(monthlyWage);
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
   * Comprehensive employment offer evaluation.
   */
  static evaluateOffer(offerTerms = {}) {
    const gross = offerTerms.totalSalary || offerTerms.gross || (offerTerms.basic ? offerTerms.basic / 0.65 : 0);
    const structure = KsaOfferCalculator.calculateSalaryStructure(gross);

    const isSaudi = offerTerms.isSaudiNational !== false;
    const gosi = KsaOfferCalculator.calculateGosi(structure, isSaudi);

    const netMonthly = Number((structure.gross - gosi.employeeDeduction).toFixed(2));

    const probationDays = offerTerms.probationDays || 90;
    const probationIssues = [];
    if (probationDays > 180) {
      probationIssues.push(`Probation of ${probationDays} days violates Article 53 statutory limit of 180 days.`);
    } else if (probationDays > 90) {
      probationIssues.push(`Probation is ${probationDays} days. Article 53 requires explicit mutual written agreement to exceed 90 days.`);
    }

    const nonCompete = KsaOfferCalculator.validateNonCompete({
      durationMonths: offerTerms.nonCompeteMonths,
      geographicScope: offerTerms.nonCompeteScope
    });

    return {
      structure,
      gosi,
      netMonthlyTakeHome: netMonthly,
      probation: {
        days: probationDays,
        valid: probationDays <= 180,
        issues: probationIssues
      },
      nonCompete,
      summary: `Gross: ${structure.gross} SAR | Net: ${netMonthly} SAR | GOSI: ${gosi.employeeDeduction} SAR`
    };
  }
}

module.exports = {
  KsaOfferCalculator,
  GOSI_WAGE_CAP
};
