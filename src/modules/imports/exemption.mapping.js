'use strict';

/**
 * Import-time exemption resolution — grounded in APSEC circular p.61
 * "Exempted Categories: (a)(i)-(viii)" (official text supplied by the
 * District Election Authority; see the exemption section).
 *
 * What this module resolves automatically (sheet Department + row
 * Designation — the only two signals the proforma carries):
 *  (i)   Veterinary hospitals: Doctors and Compounders. A designation
 *        containing "veterinary" carries its own context; a bare
 *        "Compounder" counts only on a veterinary sheet (Health-Department
 *        compounders are NOT listed in (ii)).
 *  (ii)  Health Department: Doctors, Nurses, ANMs. BOTH signals required —
 *        a "Doctor" elsewhere (Railways, ESI, private) is NOT exempt, and a
 *        "Clerk" on a Health sheet is NOT exempt. NOTE: this needs the new
 *        HEALTH_MEDICAL category (doctors were missing from the enum).
 *  (iii) Ayush Department: Ayurvedic / Unani / Homeopathic Medical Officers.
 *        A designation stating the system (BAMS/BHMS/BUMS, Ayurvedic, Unani,
 *        Homeopathic) carries its own context; a bare "Medical Officer" or
 *        "Doctor" counts only on an Ayush sheet.
 *  (iv)  All India Radio — the whole sheet (circular exempts the STAFF).
 *  (v)   Doordarshan — the whole sheet.
 *  (vi)  BSNL/MTNL operational technical staff. Soft rule: the circular says
 *        "only in unavoidable circumstances" (not a blanket ban), so these
 *        are marked exempt by default and the authority may override later.
 *
 * Deliberately NOT auto-resolved (data absent — left NULL, never guessed):
 *  (vii) Rural single-officer bank branches: the sheet carries neither the
 *        posting location nor the branch staffing. A "Bank" designation or
 *        department alone does NOT exempt.
 *  (viii) Pregnancy / breastfeeding / medical unfitness: personal medical
 *        status, not present in any spreadsheet. Needs an authority flag.
 *
 * resolveExemption(departmentName, designation) -> { category, rule } | null
 * `category` matches the EXEMPT_CATEGORY string values so Stage 1's filter
 * (which checks membership) works without any change.
 */

const DEPT = {
  VETERINARY: /veterin/i,
  HEALTH: /health/i,
  AYUSH: /ayush|ayurved|unani|homeopath/i,
  AIR: /all\s*india\s*radio|\bair\b|prasar\s*bharati/i,
  DOORDARSHAN: /doordarshan/i,
  BSNL: /\bbsnl\b|\bmtnl\b/i,
};

const DESIG = {
  VETERINARY: /veterin/i,
  COMPOUNDER: /compound/i,
  HEALTH_CLINICAL: /doctor|medical\s*officer|\bnurse\b|\banm\b/i,
  AYUSH_EXPLICIT: /ayurved|unani|homeopath|\bbams\b|\bbhms\b|\bbums\b/i,
  MEDICAL_OFFICER: /medical\s*officer|\bdoctor\b/i,
  BSNL_TECH: /telecom|technician|mechanic|electrician|operator|installer|lineman|wireman|\bjto\b|\bsdo\b/i,
};

function has(value, pattern) {
  return typeof value === 'string' && pattern.test(value);
}

function resolveExemption(departmentName, designation) {
  const dept = has(departmentName, /.+/s) ? departmentName : '';
  const desig = designation || '';

  // (i) Veterinary hospitals.
  if (has(desig, DESIG.VETERINARY)) {
    return { category: 'veterinary_staff', rule: 'p61(i)-designation' };
  }
  if (has(desig, DESIG.COMPOUNDER) && has(dept, DEPT.VETERINARY)) {
    return { category: 'veterinary_staff', rule: 'p61(i)-compounder' };
  }

  // (iv) All India Radio, (v) Doordarshan — whole-sheet exemptions.
  if (has(dept, DEPT.AIR)) {
    return { category: 'all_india_radio', rule: 'p61(iv)-department' };
  }
  if (has(dept, DEPT.DOORDARSHAN)) {
    return { category: 'doordarshan', rule: 'p61(v)-department' };
  }

  // (ii) Health Department clinical staff — designation AND department.
  if (has(desig, DESIG.HEALTH_CLINICAL) && has(dept, DEPT.HEALTH)) {
    if (/nurse|\banm\b/i.test(desig)) {
      return { category: 'nurse_anm', rule: 'p61(ii)-health' };
    }
    return { category: 'health_medical', rule: 'p61(ii)-health' };
  }

  // (iii) Ayush medical officers.
  if (has(desig, DESIG.AYUSH_EXPLICIT)) {
    return { category: 'ayush_medical', rule: 'p61(iii)-designation' };
  }
  if (has(desig, DESIG.MEDICAL_OFFICER) && has(dept, DEPT.AYUSH)) {
    return { category: 'ayush_medical', rule: 'p61(iii)-department' };
  }

  // (vi) BSNL/MTNL operational-technical staff (soft: mark exempt by default).
  if (has(dept, DEPT.BSNL) && has(desig, DESIG.BSNL_TECH)) {
    return { category: 'bsnl_mtnl_ops', rule: 'p61(vi)-technical' };
  }

  return null;
}

module.exports = { resolveExemption, DEPT, DESIG };
