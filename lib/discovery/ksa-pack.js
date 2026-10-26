'use strict';

/**
 * JobHunt Crew — KSA/GCC Country Pack & Arabic Query Normalization Engine
 *
 * Provides:
 * 1. 40+ strategic enterprise, giga-project, and tech watchlist.
 * 2. Saudization (توطين / سعودة) & HRSD localized roles detection with candidate work-auth matching.
 * 3. In-Kingdom Transferable Iqama (نقل كفالة) vs offshore visa sponsorship verification.
 * 4. Cold-offer scam and recruitment phishing sentinel (upfront fees, Western Union, crypto rails).
 * 5. Arabic morphological normalization and light-stemming search query engine.
 * 6. Strict Arabic CV gating policy (English default; Arabic generated strictly on explicit mandate).
 *
 * @module lib/discovery/ksa-pack
 */

// ============================================================================
// 1. 40+ STRATEGIC ENTERPRISE WATCHLIST
// ============================================================================

const KSA_WATCHLIST = [
  // Giga-Projects & Vision 2030 Flagships
  {
    id: 'neom',
    name: 'NEOM',
    nameAr: 'نيوم',
    category: 'giga_project',
    provider: 'oraclecloud',
    careersUrl: 'https://careers.neom.com',
    primaryCity: 'NEOM',
    cities: ['Tabuk', 'Riyadh'],
    aliases: ['The Line', 'Oxagon', 'Trojena', 'Sindalah', 'ذا لاين', 'أكسوجين', 'نيوم'],
    tier1: true,
    enabled: true
  },
  {
    id: 'red-sea-global',
    name: 'Red Sea Global',
    nameAr: 'البحر الأحمر الدولية',
    category: 'giga_project',
    provider: 'oraclecloud',
    careersUrl: 'https://careers.redseaglobal.com',
    primaryCity: 'Tabuk',
    cities: ['Red Sea', 'Amaala', 'Riyadh'],
    aliases: ['RSG', 'Amaala', 'أمالا', 'مشروع البحر الأحمر', 'البحر الاحمر الدولية'],
    tier1: true,
    enabled: true
  },
  {
    id: 'qiddiya',
    name: 'Qiddiya Investment Company',
    nameAr: 'شركة القدية للاستثمار',
    category: 'giga_project',
    provider: 'oraclecloud',
    careersUrl: 'https://careers.qiddiya.com',
    primaryCity: 'Qiddiya',
    cities: ['Riyadh'],
    aliases: ['QIC', 'القدية', 'مشروع القدية'],
    tier1: true,
    enabled: true
  },
  {
    id: 'roshn',
    name: 'ROSHN',
    nameAr: 'روشن',
    category: 'giga_project',
    provider: 'oraclecloud',
    careersUrl: 'https://careers.roshn.sa',
    primaryCity: 'Riyadh',
    cities: ['Jeddah', 'Makkah', 'Dammam'],
    aliases: ['مجموعة روشن', 'ROSHN Group', 'روشن العقارية'],
    tier1: true,
    enabled: true
  },
  {
    id: 'diriyah',
    name: 'Diriyah Company',
    nameAr: 'شركة الدرعية',
    category: 'giga_project',
    provider: 'oraclecloud',
    careersUrl: 'https://careers.diriyah.sa',
    primaryCity: 'Diriyah',
    cities: ['Riyadh'],
    aliases: ['DGDA', 'هيئة تطوير بوابة الدرعية', 'بوابة الدرعية', 'الدرعية'],
    tier1: true,
    enabled: true
  },
  {
    id: 'pif',
    name: 'Public Investment Fund',
    nameAr: 'صندوق الاستثمارات العامة',
    category: 'sovereign_wealth',
    provider: 'workday',
    careersUrl: 'https://pif.gov.sa/en/careers',
    primaryCity: 'Riyadh',
    cities: ['London', 'New York', 'Hong Kong'],
    aliases: ['PIF', 'الصندوق السيادي السعودي', 'صندوق الاستثمارات العامة'],
    tier1: true,
    enabled: true
  },
  {
    id: 'new-murabba',
    name: 'New Murabba Development Company',
    nameAr: 'شركة تطوير المربع الجديد',
    category: 'giga_project',
    provider: 'oraclecloud',
    careersUrl: 'https://newmurabba.com/en/careers',
    primaryCity: 'Riyadh',
    cities: [],
    aliases: ['NMDC', 'المربع الجديد', 'المكعب', 'Mukaab'],
    tier1: true,
    enabled: true
  },
  {
    id: 'soudah',
    name: 'Soudah Development',
    nameAr: 'السودة للتطوير',
    category: 'giga_project',
    provider: 'oraclecloud',
    careersUrl: 'https://soudah.sa/en/careers',
    primaryCity: 'Abha',
    cities: ['Asir', 'Riyadh'],
    aliases: ['سودة عسير', 'Soudah Peaks', 'قمم السودة'],
    tier1: true,
    enabled: true
  },
  {
    id: 'rua-al-madinah',
    name: 'Rua Al Madinah Holding',
    nameAr: 'رؤى المدينة القابضة',
    category: 'giga_project',
    provider: 'oraclecloud',
    careersUrl: 'https://ruaalmadinah.com/careers',
    primaryCity: 'Madinah',
    cities: ['Riyadh'],
    aliases: ['رؤى المدينة', 'Rua AlMadinah'],
    tier1: true,
    enabled: true
  },

  // National Champions & Sovereign Enterprises
  {
    id: 'riyadh-air',
    name: 'Riyadh Air',
    nameAr: 'طيران الرياض',
    category: 'national_champion',
    provider: 'workday',
    careersUrl: 'https://careers.riyadhair.com',
    primaryCity: 'Riyadh',
    cities: [],
    aliases: ['الناقل الجوي الوطني الجديد', 'طيران الرياض'],
    tier1: true,
    enabled: true
  },
  {
    id: 'alat',
    name: 'Alat',
    nameAr: 'آلات',
    category: 'national_champion',
    provider: 'workday',
    careersUrl: 'https://alat.com/en-us/careers',
    primaryCity: 'Riyadh',
    cities: [],
    aliases: ['شركة آلات', 'Alat Electronics', 'آلات السعودية'],
    tier1: true,
    enabled: true
  },
  {
    id: 'humain',
    name: 'HUMAIN',
    nameAr: 'هيومان',
    category: 'national_champion',
    provider: 'oraclecloud',
    careersUrl: 'https://scai.sa/careers',
    primaryCity: 'Riyadh',
    cities: [],
    aliases: ['SCAI', 'شركة الذكاء الاصطناعي', 'Saudi Company for AI'],
    tier1: true,
    enabled: true
  },
  {
    id: 'saudi-aramco',
    name: 'Saudi Aramco',
    nameAr: 'أرامكو السعودية',
    category: 'national_champion',
    provider: 'successfactors',
    careersUrl: 'https://www.aramco.com/en/careers',
    primaryCity: 'Dhahran',
    cities: ['Riyadh', 'Jeddah', 'Ras Tanura'],
    aliases: ['Aramco', 'أرامكو', 'أرامكو السعودية'],
    tier1: true,
    enabled: true
  },
  {
    id: 'aramco-digital',
    name: 'Aramco Digital',
    nameAr: 'أرامكو الرقمية',
    category: 'national_champion',
    provider: 'workday',
    careersUrl: 'https://aramcodigital.com/careers',
    primaryCity: 'Dhahran',
    cities: ['Riyadh'],
    aliases: ['Aramco Digital Company', 'أرامكو الرقمية'],
    tier1: true,
    enabled: true
  },
  {
    id: 'stc',
    name: 'STC (Saudi Telecom Company)',
    nameAr: 'شركة الاتصالات السعودية',
    category: 'national_champion',
    provider: 'workday',
    careersUrl: 'https://careers.stc.com.sa',
    primaryCity: 'Riyadh',
    cities: ['Jeddah', 'Dammam'],
    aliases: ['stc group', 'إس تي سي', 'الاتصالات السعودية'],
    tier1: true,
    enabled: true
  },
  {
    id: 'solutions-by-stc',
    name: 'Solutions by stc',
    nameAr: 'سلوشنز من إس تي سي',
    category: 'national_champion',
    provider: 'workday',
    careersUrl: 'https://solutions.com.sa/careers',
    primaryCity: 'Riyadh',
    cities: [],
    aliases: ['Arabian Internet and Telecom', 'سلوشنز', 'سلوشنز للاتصالات'],
    tier1: true,
    enabled: true
  },
  {
    id: 'sirar-by-stc',
    name: 'Sirar by stc',
    nameAr: 'سرار من إس تي سي',
    category: 'national_champion',
    provider: 'workday',
    careersUrl: 'https://sirar.com.sa/careers',
    primaryCity: 'Riyadh',
    cities: [],
    aliases: ['Sirar Cyber', 'الأمن السيبراني سرار', 'سرار'],
    tier1: true,
    enabled: true
  },
  {
    id: 'sabic',
    name: 'SABIC',
    nameAr: 'سابك',
    category: 'national_champion',
    provider: 'workday',
    careersUrl: 'https://careers.sabic.com',
    primaryCity: 'Riyadh',
    cities: ['Jubail', 'Yanbu'],
    aliases: ['Saudi Basic Industries Corporation', 'الشركة السعودية للصناعات الأساسية', 'سابك'],
    tier1: true,
    enabled: true
  },
  {
    id: 'almarai',
    name: 'Almarai Company',
    nameAr: 'شركة المراعي',
    category: 'national_champion',
    provider: 'workday',
    careersUrl: 'https://almarai.com/en/corporate/careers',
    primaryCity: 'Riyadh',
    cities: ['Al Kharj'],
    aliases: ['المراعي', 'شركة المراعي المحدودة'],
    tier1: true,
    enabled: true
  },
  {
    id: 'elm',
    name: 'Elm',
    nameAr: 'شركة علم',
    category: 'national_champion',
    provider: 'workday',
    careersUrl: 'https://elm.sa/en/careers',
    primaryCity: 'Riyadh',
    cities: [],
    aliases: ['علم لأمن المعلومات', 'Elm Security', 'شركة علم'],
    tier1: true,
    enabled: true
  },
  {
    id: 'maaden',
    name: "Ma'aden",
    nameAr: 'شركة معادن',
    category: 'national_champion',
    provider: 'workday',
    careersUrl: 'https://maaden.com.sa/en/careers',
    primaryCity: 'Riyadh',
    cities: ['Ras Al Khair', 'Waad Al Shamal'],
    aliases: ['Saudi Arabian Mining Company', 'التعدين العربية السعودية', 'معادن'],
    tier1: true,
    enabled: true
  },
  {
    id: 'acwa-power',
    name: 'ACWA Power',
    nameAr: 'أكوا باور',
    category: 'national_champion',
    provider: 'workday',
    careersUrl: 'https://acwapower.com/en/careers',
    primaryCity: 'Riyadh',
    cities: ['Jeddah'],
    aliases: ['أكوا باور للمياه والطاقة', 'ACWA'],
    tier1: true,
    enabled: true
  },
  {
    id: 'bupa-arabia',
    name: 'Bupa Arabia',
    nameAr: 'بوبا العربية',
    category: 'national_champion',
    provider: 'workday',
    careersUrl: 'https://bupa.com.sa/en/careers',
    primaryCity: 'Jeddah',
    cities: ['Riyadh', 'Khobar'],
    aliases: ['بوبا للتأمين', 'بوبا العربية للتأمين'],
    tier1: false,
    enabled: true
  },
  {
    id: 'saudi-electricity',
    name: 'Saudi Electricity Company',
    nameAr: 'الشركة السعودية للكهرباء',
    category: 'national_champion',
    provider: 'oraclecloud',
    careersUrl: 'https://se.com.sa/en/careers',
    primaryCity: 'Riyadh',
    cities: ['Jeddah', 'Dammam'],
    aliases: ['SEC', 'كهرباء السعودية', 'الشركة السعودية للكهرباء'],
    tier1: false,
    enabled: true
  },

  // Banking & Financial Champions
  {
    id: 'al-rajhi-bank',
    name: 'Al Rajhi Bank',
    nameAr: 'مصرف الراجحي',
    category: 'banking_finance',
    provider: 'oraclecloud',
    careersUrl: 'https://careers.alrajhibank.com.sa',
    primaryCity: 'Riyadh',
    cities: ['Jeddah', 'Dammam'],
    aliases: ['الراجحي', 'Alrajhi', 'Al Rajhi Banking', 'مصرف الراجحي'],
    tier1: true,
    enabled: true
  },
  {
    id: 'snb',
    name: 'Saudi National Bank (SNB)',
    nameAr: 'البنك الأهلي السعودي',
    category: 'banking_finance',
    provider: 'workday',
    careersUrl: 'https://alahli.com/en-us/about-us/careers',
    primaryCity: 'Riyadh',
    cities: ['Jeddah'],
    aliases: ['AlAhli Bank', 'البنك الأهلي', 'الأهلي التجاري', 'SNB'],
    tier1: true,
    enabled: true
  },
  {
    id: 'riyad-bank',
    name: 'Riyad Bank',
    nameAr: 'بنك الرياض',
    category: 'banking_finance',
    provider: 'oraclecloud',
    careersUrl: 'https://riyadbank.com/en/careers',
    primaryCity: 'Riyadh',
    cities: ['Jeddah', 'Dammam'],
    aliases: ['بنك الرياض', 'RiyadBank'],
    tier1: false,
    enabled: true
  },
  {
    id: 'banque-saudi-fransi',
    name: 'Banque Saudi Fransi',
    nameAr: 'البنك السعودي الفرنسي',
    category: 'banking_finance',
    provider: 'oraclecloud',
    careersUrl: 'https://alfransi.com.sa/en/careers',
    primaryCity: 'Riyadh',
    cities: ['Jeddah'],
    aliases: ['BSF', 'فرنسي', 'السعودي الفرنسي'],
    tier1: false,
    enabled: true
  },
  {
    id: 'sab',
    name: 'Saudi Awwal Bank (SAB)',
    nameAr: 'البنك السعودي الأول',
    category: 'banking_finance',
    provider: 'workday',
    careersUrl: 'https://sab.com/en/careers',
    primaryCity: 'Riyadh',
    cities: ['Jeddah', 'Khobar'],
    aliases: ['SAB', 'الأول', 'سابقاً ساب', 'البنك السعودي الأول'],
    tier1: false,
    enabled: true
  },
  {
    id: 'alinma-bank',
    name: 'Alinma Bank',
    nameAr: 'مصرف الإنماء',
    category: 'banking_finance',
    provider: 'oraclecloud',
    careersUrl: 'https://alinma.com/en/careers',
    primaryCity: 'Riyadh',
    cities: ['Jeddah'],
    aliases: ['الإنماء', 'مصرف الإنماء'],
    tier1: false,
    enabled: true
  },

  // Tech Unicorns, Fintech & High-Growth Scaleups
  {
    id: 'tamara',
    name: 'Tamara',
    nameAr: 'تمارا',
    category: 'tech_unicorn',
    provider: 'lever',
    careersUrl: 'https://jobs.lever.co/tamara',
    primaryCity: 'Riyadh',
    cities: ['Dubai', 'Cairo'],
    aliases: ['Tamara BNPL', 'اشتر الآن وادفع لاحقاً تمارا', 'تمارا'],
    tier1: true,
    enabled: true
  },
  {
    id: 'tabby',
    name: 'Tabby',
    nameAr: 'تابي',
    category: 'tech_unicorn',
    provider: 'lever',
    careersUrl: 'https://jobs.lever.co/tabby',
    primaryCity: 'Riyadh',
    cities: ['Dubai'],
    aliases: ['Tabby Payments', 'تابي السعودية', 'تابي'],
    tier1: true,
    enabled: true
  },
  {
    id: 'jahez',
    name: 'Jahez',
    nameAr: 'جاهز',
    category: 'tech_unicorn',
    provider: 'smartrecruiters',
    careersUrl: 'https://careers.smartrecruiters.com/Jahez',
    primaryCity: 'Riyadh',
    cities: [],
    aliases: ['Jahez International', 'شركة جاهز', 'جاهز للاتصالات وتقنية المعلومات'],
    tier1: true,
    enabled: true
  },
  {
    id: 'hungerstation',
    name: 'HungerStation',
    nameAr: 'هنقرستيشن',
    category: 'tech_unicorn',
    provider: 'smartrecruiters',
    careersUrl: 'https://careers.smartrecruiters.com/HungerStation',
    primaryCity: 'Riyadh',
    cities: [],
    aliases: ['هنجرستيشن', 'هنقرستيشن', 'Hungerstation Delivery'],
    tier1: true,
    enabled: true
  },
  {
    id: 'salla',
    name: 'Salla',
    nameAr: 'سلة',
    category: 'tech_unicorn',
    provider: 'greenhouse',
    careersUrl: 'https://boards.greenhouse.io/salla',
    primaryCity: 'Makkah',
    cities: ['Riyadh'],
    aliases: ['منصة سلة', 'Salla App', 'سلة للتجارة الإلكترونية'],
    tier1: true,
    enabled: true
  },
  {
    id: 'zid',
    name: 'Zid',
    nameAr: 'زد',
    category: 'scaleup',
    provider: 'bamboohr',
    careersUrl: 'https://zid.bamboohr.com/careers',
    primaryCity: 'Riyadh',
    cities: [],
    aliases: ['منصة زد للتجارة', 'شركة زد', 'زد'],
    tier1: false,
    enabled: true
  },
  {
    id: 'foodics',
    name: 'Foodics',
    nameAr: 'فودكس',
    category: 'scaleup',
    provider: 'greenhouse',
    careersUrl: 'https://boards.greenhouse.io/foodics',
    primaryCity: 'Riyadh',
    cities: [],
    aliases: ['فودكس لحلول المطاعم', 'فودكس POS'],
    tier1: false,
    enabled: true
  },
  {
    id: 'lean-technologies',
    name: 'Lean Technologies',
    nameAr: 'لين تكنولوجيز',
    category: 'scaleup',
    provider: 'ashby',
    careersUrl: 'https://jobs.ashbyhq.com/lean-technologies',
    primaryCity: 'Riyadh',
    cities: ['Dubai'],
    aliases: ['Lean Open Banking', 'المصرفية المفتوحة لين', 'لين'],
    tier1: true,
    enabled: true
  },
  {
    id: 'mozn',
    name: 'Mozn',
    nameAr: 'مزن',
    category: 'scaleup',
    provider: 'greenhouse',
    careersUrl: 'https://boards.greenhouse.io/mozn',
    primaryCity: 'Riyadh',
    cities: [],
    aliases: ['مزن لحلول الذكاء الاصطناعي', 'FOCAL', 'مزن'],
    tier1: false,
    enabled: true
  },
  {
    id: 'nana',
    name: 'Nana',
    nameAr: 'نعناع',
    category: 'scaleup',
    provider: 'lever',
    careersUrl: 'https://jobs.lever.co/nana',
    primaryCity: 'Riyadh',
    cities: [],
    aliases: ['تطبيق نعناع', 'مقاضي نعناع', 'شركة نعناع'],
    tier1: false,
    enabled: true
  },
  {
    id: 'floward',
    name: 'Floward',
    nameAr: 'فلاورد',
    category: 'scaleup',
    provider: 'greenhouse',
    careersUrl: 'https://boards.greenhouse.io/floward',
    primaryCity: 'Riyadh',
    cities: ['Kuwait', 'Dubai'],
    aliases: ['فلاورد للهدايا والورود', 'فلاورد'],
    tier1: false,
    enabled: true
  }
];

class KsaWatchlistRegistry {
  constructor(watchlist = KSA_WATCHLIST) {
    this.watchlist = watchlist;
    this.idMap = new Map(watchlist.map(e => [e.id, e]));
    this.aliasMap = new Map();

    for (const enterprise of watchlist) {
      this.aliasMap.set(enterprise.name.toLowerCase(), enterprise);
      this.aliasMap.set(enterprise.nameAr, enterprise);
      for (const alias of enterprise.aliases || []) {
        this.aliasMap.set(alias.toLowerCase(), enterprise);
      }
    }
  }

  getById(id) {
    return this.idMap.get(id) || null;
  }

  findByCompanyName(companyName) {
    if (!companyName || typeof companyName !== 'string') return null;
    const clean = companyName.trim().toLowerCase();

    if (this.aliasMap.has(clean)) {
      return this.aliasMap.get(clean);
    }

    for (const [alias, enterprise] of this.aliasMap.entries()) {
      if (clean.includes(alias) || alias.includes(clean)) {
        return enterprise;
      }
    }
    return null;
  }

  getByCategory(category) {
    return this.watchlist.filter(e => e.category === category && e.enabled);
  }

  getByCity(city) {
    const cleanCity = String(city || '').trim().toLowerCase();
    return this.watchlist.filter(e =>
      e.enabled && (
        e.primaryCity.toLowerCase().includes(cleanCity) ||
        (Array.isArray(e.cities) && e.cities.some(c => c.toLowerCase().includes(cleanCity)))
      )
    );
  }
}

// ============================================================================
// 2. SAUDIZATION & LOCALIZED PROFESSIONS
// ============================================================================

const SAUDIZATION_PATTERNS = [
  /\b(?:saudi\s+nationals?\s+only)\b/i,
  /\b(?:saudi\s+citizens?\s+only)\b/i,
  /\b(?:saudis?\s+only)\b/i,
  /\b(?:for\s+saudis?\s+only)\b/i,
  /\b(?:open\s+(?:only\s+)?for\s+saudi\s+nationals?)\b/i,
  /\b(?:strictly\s+(?:for\s+)?saudi\s+nationals?)\b/i,
  /\b(?:requires?\s+saudi\s+citizenship)\b/i,
  /\b(?:saudi\s+national\s+candidates?\s+only)\b/i,
  /\b(?:position\s+reserved\s+for\s+saudi\s+nationals?)\b/i,
  /\b(?:due\s+to\s+saudization\s+(?:quotas?|regulations?))\b/i,
  /السعوديين\s+فقط/,
  /للسعوديين\s+فقط/,
  /للسعوديين\s+والسعوديات\s+فقط/,
  /للمواطنين\s+فقط/,
  /مخصصة\s+للمواطنين/,
  /مخصص\s+للسعوديين/,
  /سعودي\s+الجنسية/,
  /سعودية\s+الجنسية/,
  /خاص\s+بالسعوديين/,
  /يشترط\s+أن\s+يكون\s+المتقدم\s+سعودي/,
  /متاح\s+للسعوديين\s+فقط/,
  /وظيفة\s+مسعودة/,
  /توطين\s+الوظيفة/,
  /حصر\s+الوظيفة\s+على\s+المواطنين/
];

const LOCALIZED_PROFESSIONS = [
  {
    category: 'Human Resources',
    enPatterns: [
      /\b(?:human\s+resources?\s+(?:officer|specialist|manager|director|generalist|coordinator))\b/i,
      /\b(?:hr\s+(?:officer|specialist|manager|director|generalist|coordinator))\b/i,
      /\b(?:personnel\s+manager)\b/i,
      /\b(?:talent\s+acquisition\s+(?:specialist|manager)\s+local)\b/i
    ],
    arPatterns: [
      /أخصائي\s+موارد\s+بشرية/,
      /اخصائي\s+موارد\s+بشرية/,
      /مدير\s+موارد\s+بشرية/,
      /مسؤول\s+موارد\s+بشرية/,
      /منسق\s+موارد\s+بشرية/,
      /مدير\s+شؤون\s+الموظفين/,
      /أخصائي\s+شؤون\s+موظفين/
    ]
  },
  {
    category: 'Government Relations (GRO)',
    enPatterns: [
      /\b(?:government\s+relations?\s+(?:officer|specialist|manager|representative))\b/i,
      /\b(?:gro\s+officer)\b/i,
      /\b(?:public\s+relations\s+representative)\b/i
    ],
    arPatterns: [
      /مندوب\s+علاقات\s+حكومية/,
      /مسؤول\s+علاقات\s+حكومية/,
      /معقب/,
      /أخصائي\s+علاقات\s+حكومية/
    ]
  },
  {
    category: 'Procurement & Purchasing',
    enPatterns: [
      /\b(?:procurement\s+(?:representative|clerk|officer))\b/i,
      /\b(?:purchasing\s+(?:representative|clerk|agent))\b/i
    ],
    arPatterns: [
      /مندوب\s+مشتريات/,
      /أخصائي\s+مشتريات\s+محلية/,
      /موظف\s+مشتريات/
    ]
  },
  {
    category: 'Front Desk & Administration',
    enPatterns: [
      /\b(?:receptionist)\b/i,
      /\b(?:front\s+desk\s+(?:officer|clerk|agent))\b/i,
      /\b(?:security\s+guard)\b/i
    ],
    arPatterns: [
      /موظف\s+استقبال/,
      /موظفة\s+استقبال/,
      /حارس\s+أمن/,
      /سكرتير\s+تنفيذي/
    ]
  }
];

// ============================================================================
// 3. IQAMA TRANSFERABILITY & RESIDENCY ENGINE
// ============================================================================

const IQAMA_TRANSFER_PATTERNS = [
  /\b(?:transferable\s+iqama)\b/i,
  /\b(?:transferrable\s+iqama)\b/i,
  /\b(?:iqama\s+transfer)\b/i,
  /\b(?:valid\s+and\s+transferable\s+iqama)\b/i,
  /\b(?:transferable\s+visa)\b/i,
  /\b(?:must\s+have\s+transferable\s+iqama)\b/i,
  /\b(?:in-?kingdom\s+transfer\s+only)\b/i,
  /\b(?:local\s+transfer\s+only)\b/i,
  /\b(?:must\s+be\s+currently\s+located\s+in\s+saudi\s+arabia)\b/i,
  /\b(?:resident\s+in\s+ksa\s+with\s+transferable\s+iqama)\b/i,
  /إقامة\s+قابلة\s+للتحويل/,
  /اقامة\s+قابلة\s+للتحويل/,
  /إقامة\s+قابلة\s+للنقل/,
  /اقامة\s+قابلة\s+للنقل/,
  /نقل\s+كفالة/,
  /قابل\s+للتحويل/,
  /قابلة\s+للنقل/,
  /نقل\s+خدمات/,
  /إقامة\s+نظامية\s+قابلة\s+للتحويل/,
  /تحويل\s+الإقامة/,
  /يشترط\s+إقامة\s+سارية\s+قابلة\s+للتحويل/
];

const VISA_SPONSORSHIP_AVAILABLE = [
  /\b(?:visa\s+(?:sponsorship\s+)?provided)\b/i,
  /\b(?:visa\s+available)\b/i,
  /\b(?:block\s+visa\s+available)\b/i,
  /\b(?:overseas\s+(?:candidates|applicants)\s+welcome)\b/i,
  /\b(?:relocation\s+(?:package|assistance)\s+provided)\b/i,
  /\b(?:international\s+applicants?\s+welcome)\b/i,
  /توفير\s+تأشيرة/,
  /تأشيرة\s+عمل\s+متوفرة/,
  /استقدام\s+متاح/,
  /تأشيرات\s+جاهزة/,
  /ترحيب\s+بالمتقدمين\s+من\s+خارج\s+المملكة/
];

const NO_VISA_SPONSORSHIP = [
  /\b(?:no\s+visa\s+sponsorship)\b/i,
  /\b(?:cannot\s+sponsor\s+(?:visas?|relocation))\b/i,
  /\b(?:sponsorship\s+not\s+(?:available|offered|provided))\b/i,
  /\b(?:no\s+overseas\s+hiring)\b/i,
  /لا\s+نوفر\s+تأشيرة/,
  /لا\s+يوجد\s+استقدام/,
  /غير\s+متاح\s+تأشيرة/,
  /لا\s+يتوفر\s+نقل\s+كفالة/
];

class IqamaTransferEngine {
  static evaluate(jobText, candidateStatus) {
    const text = jobText || '';
    const requiresIqama = IQAMA_TRANSFER_PATTERNS.some(p => p.test(text));
    const visaAvailable = VISA_SPONSORSHIP_AVAILABLE.some(p => p.test(text));
    const noSponsorship = NO_VISA_SPONSORSHIP.some(p => p.test(text));

    if (candidateStatus === 'Saudi National' || candidateStatus === 'GCC National') {
      return {
        applicable: false,
        eligible: true,
        requiresTransferableIqama: false,
        reason: null
      };
    }

    if (candidateStatus === 'Transferable Iqama') {
      return {
        applicable: true,
        eligible: true,
        requiresTransferableIqama: requiresIqama,
        inKingdomMatch: true,
        reason: requiresIqama ? 'Matched in-Kingdom transferable Iqama requirement' : null
      };
    }

    if (candidateStatus === 'Requires Visa Sponsorship') {
      if (noSponsorship || (requiresIqama && !visaAvailable)) {
        return {
          applicable: true,
          eligible: false,
          requiresTransferableIqama: true,
          reason: 'Position mandates local Transferable Iqama; overseas visa sponsorship is not offered.'
        };
      }
      return {
        applicable: true,
        eligible: visaAvailable || !requiresIqama,
        requiresTransferableIqama: false,
        reason: visaAvailable ? 'Overseas sponsorship explicitly available' : 'Open vacancy without explicit transfer mandate'
      };
    }

    return { applicable: false, eligible: true, requiresTransferableIqama: requiresIqama, reason: null };
  }
}

// ============================================================================
// 4. COLD-OFFER SCAM & RECRUITMENT FRAUD SENTINEL
// ============================================================================

const SCAM_INDICATORS = {
  UPFRONT_FEE_DEMANDS: {
    weight: 45,
    level: 'CRITICAL',
    patterns: [
      /\b(?:(?:visa|work\s+permit|clearance|processing|application|medical|courier|security|registration|attestation|insurance)\s+(?:fee|deposit|charge|cost|payment))\b/i,
      /\b(?:(?:fees?|charges?|deposit)\s+(?:required|mandatory|payable|upfront))\b/i,
      /\b(?:refundable\s+visa\s+deposit)\b/i,
      /\b(?:send\s+(?:\$\d+|€\d+|\d+\s*sar)\s+(?:for\s+processing|to\s+secure))\b/i,
      /رسوم\s*(?:تأشيرة|معاملة|تسجيل|توظيف|تخليص|استقدام|أوراق)/,
      /دفع\s*مسبق/,
      /مبلغ\s*تأمين\s*مسترد/,
      /تحويل\s*رسوم/
    ]
  },
  UNTRACEABLE_PAYMENT_RAILS: {
    weight: 40,
    level: 'CRITICAL',
    patterns: [
      /\b(?:western\s+union|moneygram|money\s+gram)\b/i,
      /\b(?:cryptocurrency|crypto\s+transfer|bitcoin|btc|usdt|binance|gift\s+cards?|send\s+crypto)\b/i,
      /\b(?:personal\s+bank\s+account\s+transfer)\b/i,
      /ويسترن\s+يونيون/,
      /موني\s+جرام/,
      /عملات\s+رقمية/,
      /بتكوين/
    ]
  },
  SUSPICIOUS_COMMUNICATION_CHANNELS: {
    weight: 25,
    level: 'HIGH',
    patterns: [
      /\b(?:contact\s+(?:us\s+)?via\s+whatsapp)\b/i,
      /\b(?:send\s+cv\s+to\s+whatsapp)\b/i,
      /\b(?:whatsapp\s+(?:only|interview|number|\+\d{10,}))\b/i,
      /\b(?:telegram\s+(?:only|channel|interview))\b/i,
      /تواصل\s+عبر\s+واتساب/,
      /واتساب\s+فقط/,
      /إرسال\s+السيرة\s+على\s+الواتساب/,
      /تيليجرام\s+فقط/
    ]
  },
  UNSOLICITED_COLD_OFFERS: {
    weight: 20,
    level: 'MEDIUM',
    patterns: [
      /\b(?:unconditional\s+(?:job\s+)?offer)\b/i,
      /\b(?:appointment\s+letter\s+enclosed\s+without\s+interview)\b/i,
      /\b(?:direct\s+hiring\s+without\s+interview)\b/i,
      /\b(?:selected\s+without\s+interview)\b/i,
      /\b(?:urgent\s+offer)\b/i,
      /توظيف\s+فوري\s+بدون\s+مقابلة/,
      /عرض\s+عمل\s+فوري\s+بدون\s+مقابلة/
    ]
  }
};

class ScamDetector {
  static evaluate(content, metadata = {}) {
    const text = typeof content === 'string' ? content : JSON.stringify(content);
    const senderEmail = metadata.senderEmail || '';
    const companyName = metadata.companyName || '';

    let totalScore = 0;
    const triggeredIndicators = [];

    // Upfront fee
    for (const pattern of SCAM_INDICATORS.UPFRONT_FEE_DEMANDS.patterns) {
      if (pattern.test(text)) {
        totalScore += SCAM_INDICATORS.UPFRONT_FEE_DEMANDS.weight;
        triggeredIndicators.push({
          type: 'UPFRONT_FEE_DEMAND',
          severity: 'CRITICAL',
          description: 'Demands upfront payment for visa processing, registration, or application fees.'
        });
        break;
      }
    }

    // Untraceable rails
    for (const pattern of SCAM_INDICATORS.UNTRACEABLE_PAYMENT_RAILS.patterns) {
      if (pattern.test(text)) {
        totalScore += SCAM_INDICATORS.UNTRACEABLE_PAYMENT_RAILS.weight;
        triggeredIndicators.push({
          type: 'UNTRACEABLE_PAYMENT_CHANNEL',
          severity: 'CRITICAL',
          description: 'Specifies Western Union, MoneyGram, or cryptocurrency transfer.'
        });
        break;
      }
    }

    // Suspicious communications
    for (const pattern of SCAM_INDICATORS.SUSPICIOUS_COMMUNICATION_CHANNELS.patterns) {
      if (pattern.test(text)) {
        totalScore += SCAM_INDICATORS.SUSPICIOUS_COMMUNICATION_CHANNELS.weight;
        triggeredIndicators.push({
          type: 'UNOFFICIAL_COMMUNICATION_CHANNEL',
          severity: 'HIGH',
          description: 'Conducts recruitment exclusively over WhatsApp or Telegram.'
        });
        break;
      }
    }

    // Unsolicited offers
    for (const pattern of SCAM_INDICATORS.UNSOLICITED_COLD_OFFERS.patterns) {
      if (pattern.test(text)) {
        totalScore += SCAM_INDICATORS.UNSOLICITED_COLD_OFFERS.weight;
        triggeredIndicators.push({
          type: 'UNSOLICITED_COLD_OFFER',
          severity: 'MEDIUM',
          description: 'Presents an unconditional job offer without formal interviews.'
        });
        break;
      }
    }

    // Free webmail impersonation
    if (senderEmail) {
      const lowerEmail = senderEmail.toLowerCase();
      const isFreeWebmail = /@(gmail|yahoo|hotmail|outlook|live|protonmail)\.com$/.test(lowerEmail);
      if (isFreeWebmail && /(neom|aramco|pif|roshn|redsea|qiddiya|diriyah|stc|sabic)/i.test(companyName || text)) {
        totalScore += 35;
        triggeredIndicators.push({
          type: 'SPOOFED_LOOKALIKE_DOMAIN',
          severity: 'HIGH',
          description: `Sender email (${senderEmail}) uses free webmail impersonating enterprise.`
        });
      }
    }

    const isScam = totalScore >= 40;
    const riskLevel = totalScore >= 60 ? 'HIGH' : (totalScore >= 30 ? 'MEDIUM' : (totalScore > 0 ? 'LOW' : 'NONE'));

    return {
      isColdOfferScamRisk: isScam,
      riskScore: totalScore,
      riskLevel,
      indicators: triggeredIndicators,
      reason: isScam ? `High scam probability: ${triggeredIndicators.map(i => i.description).join(' ')}` : null
    };
  }
}

// ============================================================================
// 5. ARABIC QUERY NORMALIZATION & MORPHOLOGY
// ============================================================================

class ArabicQueryNormalizer {
  static TASHKEEL_REGEX = /[\u064B-\u0655\u0640\u0670]/g;
  static ALEF_VARIANTS_REGEX = /[\u0622\u0623\u0625\u0671]/g;
  static TAA_MARBUTA_REGEX = /\u0629/g;
  static ALEF_MAQSURA_REGEX = /\u0649/g;

  /**
   * Orthographic normalization:
   * - Strips tashkeel diacritics and tatweel
   * - Unifies all alefs (أ, إ, آ, ٱ) -> ا
   * - Unifies taa marbuta (ة) -> ه
   * - Unifies alef maqsura (ى) -> ي
   */
  static normalize(text) {
    if (!text || typeof text !== 'string') return '';
    return text
      .replace(ArabicQueryNormalizer.TASHKEEL_REGEX, '')
      .replace(ArabicQueryNormalizer.ALEF_VARIANTS_REGEX, '\u0627')
      .replace(ArabicQueryNormalizer.TAA_MARBUTA_REGEX, '\u0647')
      .replace(ArabicQueryNormalizer.ALEF_MAQSURA_REGEX, '\u064A')
      .trim();
  }

  /**
   * Light-stemming: strips proclitic prefixes (ال, وال, فال, بال, لل)
   * and enclitic suffixes (ين, ون, ات, ان, ة, ه, يه).
   */
  static lightStem(word) {
    if (!word || word.length < 3) return word || '';
    let stem = ArabicQueryNormalizer.normalize(word);

    // Strip compound prefixes (وال, فال, بال, كال, لل, ال)
    stem = stem.replace(/^[وفبكل]?ال/, '');
    stem = stem.replace(/^لل/, '');

    // Strip single letter conjunction if word is long enough
    if (stem.length > 4 && /^[وف]/.test(stem)) {
      stem = stem.slice(1);
    }

    // Strip plural, dual, and feminine suffixes
    if (stem.length >= 5) {
      if (/(?:ين|ون|ات|ان)$/.test(stem)) {
        stem = stem.slice(0, -2);
      } else if (/(?:ية|يه)$/.test(stem)) {
        stem = stem.slice(0, -2);
      }
    }
    if (stem.length >= 4 && /[هة]$/.test(stem)) {
      stem = stem.slice(0, -1);
    }

    return stem;
  }

  /**
   * Builds an expansive morphological regex from an Arabic search query.
   */
  static buildSearchRegex(query) {
    if (!query) return null;
    const rawTokens = String(query).trim().split(/\s+/);
    const tokens = rawTokens
      .map(t => ArabicQueryNormalizer.lightStem(t))
      .filter(t => t.length > 0);

    if (tokens.length === 0) return null;

    const patternSegments = tokens.map(token => {
      const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Optional prefixes: [وفبكل]?, optional ال or لل
      const prefixGroup = '(?:[وفبكل]?(?:ال)?|لل)?';
      // Optional suffixes: [ةه], ين, ون, ات, ان, ية, يه
      const suffixGroup = '(?:[ةه]|ين|ون|ات|ان|ية|يه)?';
      return `${prefixGroup}${escaped}${suffixGroup}`;
    });

    const fullPattern = patternSegments.join('\\s+');
    return new RegExp(`(?:^|[^\\p{L}\\p{N}])${fullPattern}(?:$|[^\\p{L}\\p{N}])`, 'iu');
  }

  /**
   * Checks whether a target text matches an Arabic query.
   */
  static matches(targetText, query) {
    if (!targetText || !query) return false;

    // 1. Morphological regex match against normalized target
    const regex = ArabicQueryNormalizer.buildSearchRegex(query);
    const normTarget = ArabicQueryNormalizer.normalize(targetText);
    const normQuery = ArabicQueryNormalizer.normalize(query);

    if (regex && regex.test(normTarget)) {
      return true;
    }

    // 2. Direct normalized containment
    if (normTarget.includes(normQuery)) {
      return true;
    }

    // 3. Light-stem token overlap
    const targetStems = new Set(
      normTarget.split(/\s+/).map(w => ArabicQueryNormalizer.lightStem(w))
    );
    const queryStems = normQuery
      .split(/\s+/)
      .map(w => ArabicQueryNormalizer.lightStem(w))
      .filter(Boolean);

    if (queryStems.length > 0 && queryStems.every(qs => targetStems.has(qs))) {
      return true;
    }

    return false;
  }
}

// ============================================================================
// 6. STRICT ARABIC CV GATING POLICY
// ============================================================================

const ARABIC_CV_TRIGGERS_EN = [
  /\b(?:arabic\s+cv\s+(?:is\s+)?required)\b/i,
  /\b(?:arabic\s+resume\s+(?:is\s+)?required)\b/i,
  /\b(?:submit\s+(?:your|their|a\s+)?\s*cv\s+in\s+arabic)\b/i,
  /\b(?:submit\s+(?:your|their|a\s+)?\s*resume\s+in\s+arabic)\b/i,
  /\b(?:bilingual\s+cv\s+required)\b/i,
  /\b(?:arabic\s+copy\s+of\s+cv)\b/i,
  /\b(?:provide\s+cv\s+in\s+both\s+arabic\s+and\s+english)\b/i,
  /\b(?:must\s+provide\s+arabic\s+resume)\b/i,
  /\b(?:arabic\s+language\s+cv)\b/i
];

const ARABIC_CV_TRIGGERS_AR = [
  /يرجى\s+تقديم\s+السيرة\s+الذاتية\s+باللغة\s+العربية/,
  /السيرة\s+الذاتية\s+باللغة\s+العربية/,
  /تقديم\s+السيرة\s+بالعربي/,
  /إرفاق\s+السيرة\s+الذاتية\s+باللغة\s+العربية/,
  /سيرة\s+ذاتية\s+عربية/,
  /مطلوب\s+سيرة\s+ذاتية\s+بالعربية/,
  /السيرة\s+الذاتية\s+بالعربية\s+والإنجليزية/,
  /يشترط\s+تقديم\s+السيرة\s+بالعربي/
];

class ArabicCvPolicy {
  static evaluate(jobText) {
    if (!jobText || typeof jobText !== 'string') {
      return { shouldGenerateArabicCv: false, triggerPhrase: null, mode: 'ENGLISH_ONLY' };
    }

    for (const p of ARABIC_CV_TRIGGERS_EN) {
      const match = jobText.match(p);
      if (match) {
        return {
          shouldGenerateArabicCv: true,
          triggerPhrase: match[0],
          mode: 'BILINGUAL_PACK'
        };
      }
    }

    for (const p of ARABIC_CV_TRIGGERS_AR) {
      const match = jobText.match(p);
      if (match) {
        return {
          shouldGenerateArabicCv: true,
          triggerPhrase: match[0],
          mode: 'BILINGUAL_PACK'
        };
      }
    }

    return {
      shouldGenerateArabicCv: false,
      triggerPhrase: null,
      mode: 'ENGLISH_ONLY'
    };
  }
}

// ============================================================================
// 7. UNIFIED KSA COUNTRY PACK FACADE
// ============================================================================

class KsaCountryPack {
  static get watchlist() {
    return KSA_WATCHLIST;
  }

  static getWatchlistRegistry() {
    return new KsaWatchlistRegistry(KSA_WATCHLIST);
  }

  /**
   * Complete regional compliance evaluation.
   * Drop-in compatible with test-discovery-adapters.js.
   */
  static evaluateCompliance(jobText, candidateStatus = 'Transferable Iqama', metadata = {}) {
    const text = jobText || '';

    // 1. Saudization detection
    const isSaudizationRestricted = SAUDIZATION_PATTERNS.some(p => p.test(text)) ||
      LOCALIZED_PROFESSIONS.some(p =>
        p.enPatterns.some(ep => ep.test(text)) || p.arPatterns.some(ap => ap.test(text))
      );

    // 2. Work-auth check
    let eligible = true;
    let reason = null;
    let isPriority = false;

    if (isSaudizationRestricted) {
      if (candidateStatus === 'Saudi National') {
        eligible = true;
        isPriority = true;
      } else {
        eligible = false;
        reason = 'Position restricted to Saudi Nationals (Saudization)';
      }
    }

    // 3. Iqama Transfer requirement
    const iqamaEval = IqamaTransferEngine.evaluate(text, candidateStatus);
    if (eligible && !iqamaEval.eligible) {
      eligible = false;
      reason = iqamaEval.reason;
    }

    // 4. Cold-offer scam evaluation
    const scamEval = ScamDetector.evaluate(text, metadata);
    if (scamEval.isColdOfferScamRisk) {
      eligible = false;
      reason = 'High scam probability: requested upfront payment or suspicious transaction';
    }

    return {
      eligible,
      isSaudizationRestricted,
      requiresTransferableIqama: iqamaEval.requiresTransferableIqama,
      isColdOfferScamRisk: scamEval.isColdOfferScamRisk,
      scamRiskScore: scamEval.riskScore,
      scamRiskLevel: scamEval.riskLevel,
      isPriority,
      reason
    };
  }

  static normalizeArabic(text) {
    return ArabicQueryNormalizer.normalize(text);
  }

  static matchesArabicQuery(targetText, query) {
    return ArabicQueryNormalizer.matches(targetText, query);
  }

  static shouldGenerateArabicCv(jobText) {
    return ArabicCvPolicy.evaluate(jobText);
  }
}

// Top-level function exports for direct imports
function evaluateKsaCompliance(jobText, candidateStatus = 'Transferable Iqama', metadata = {}) {
  return KsaCountryPack.evaluateCompliance(jobText, candidateStatus, metadata);
}

function shouldGenerateArabicCv(jobText) {
  return ArabicCvPolicy.evaluate(jobText);
}

module.exports = {
  KsaCountryPack,
  KsaWatchlistRegistry,
  ArabicQueryNormalizer,
  ScamDetector,
  IqamaTransferEngine,
  ArabicCvPolicy,
  KSA_WATCHLIST,
  evaluateKsaCompliance,
  shouldGenerateArabicCv
};
