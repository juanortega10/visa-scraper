export const BASE_URL = 'https://ais.usvisa-info.com/es-co/niv';

export function getBaseUrl(locale: string = 'es-co'): string {
  return `https://ais.usvisa-info.com/${locale}/niv`;
}

export interface LocaleTexts {
  continueText: string;
  rescheduleText: string;
  /** Whether to include `commit` field in reschedule POST body. */
  includeCommit: boolean;
}

export function getLocaleTexts(locale: string): LocaleTexts {
  if (locale === 'es-pe') {
    return { continueText: 'Continuar', rescheduleText: 'Reprogramar', includeCommit: true };
  }
  if (locale.startsWith('es-')) {
    return { continueText: 'Continuar', rescheduleText: 'Reprogramar', includeCommit: true };
  }
  return { continueText: 'Continue', rescheduleText: 'Reschedule', includeCommit: true };
}

export const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36';

/** Extra browser headers to mimic real Chrome — reduces WAF/fingerprint blocks. */
export const BROWSER_HEADERS: Record<string, string> = {
  'sec-ch-ua': '"Not(A:Brand";v="8", "Chromium";v="144", "Google Chrome";v="144"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  'Accept-Language': 'en-US,en;q=0.9,es;q=0.8',
};


export const FACILITY = {
  BOGOTA_CONSULAR: '25',
  BOGOTA_ASC: '26',
} as const;

export type FacilityId = (typeof FACILITY)[keyof typeof FACILITY];

/** All valid locales from ais.usvisa-info.com/en-us/countries_list/niv */
export const VALID_LOCALES: Record<string, string> = {
  // The Americas
  'es-ar': 'Argentina', 'en-ar': 'Argentina',
  'en-bs': 'Bahamas', 'ht-bs': 'Bahamas',
  'en-bb': 'Barbados',
  'en-bz': 'Belize',
  'es-bo': 'Bolivia', 'en-bo': 'Bolivia',
  'pt-br': 'Brazil', 'en-br': 'Brazil',
  'en-ca': 'Canada', 'fr-ca': 'Canada',
  'es-cl': 'Chile', 'en-cl': 'Chile',
  'es-co': 'Colombia', 'en-co': 'Colombia',
  'en-cr': 'Costa Rica', 'es-cr': 'Costa Rica',
  'en-cw': 'Curacao', 'es-cw': 'Curacao',
  'en-do': 'Dominican Republic', 'es-do': 'Dominican Republic',
  'es-ec': 'Ecuador', 'en-ec': 'Ecuador',
  'en-sv': 'El Salvador', 'es-sv': 'El Salvador',
  'en-gt': 'Guatemala', 'es-gt': 'Guatemala',
  'en-gy': 'Guyana', 'es-gy': 'Guyana',
  'en-ht': 'Haiti', 'fr-ht': 'Haiti', 'ht-ht': 'Haiti',
  'en-hn': 'Honduras', 'es-hn': 'Honduras',
  'en-jm': 'Jamaica',
  'es-mx': 'Mexico', 'en-mx': 'Mexico',
  'en-ni': 'Nicaragua', 'es-ni': 'Nicaragua',
  'en-pa': 'Panama', 'es-pa': 'Panama',
  'es-py': 'Paraguay', 'en-py': 'Paraguay',
  'es-pe': 'Peru', 'en-pe': 'Peru',
  'en-sr': 'Suriname', 'nl-sr': 'Suriname',
  'en-tt': 'Trinidad and Tobago',
  'es-uy': 'Uruguay', 'en-uy': 'Uruguay',
  // Europe
  'en-ie': 'Ireland',
  'it-it': 'Italy', 'en-it': 'Italy',
  'pt-pt': 'Portugal', 'en-pt': 'Portugal',
  'es-es': 'Spain and Andorra', 'en-es': 'Spain and Andorra',
  'en-gb': 'United Kingdom',
  // Central Asia
  'en-kz': 'Kazakhstan', 'kk-kz': 'Kazakhstan', 'ru-kz': 'Kazakhstan',
  'en-kg': 'Kyrgyz Republic', 'ky-kg': 'Kyrgyz Republic', 'ru-kg': 'Kyrgyz Republic',
  'en-uz': 'Uzbekistan', 'ru-uz': 'Uzbekistan', 'uz-uz': 'Uzbekistan',
  // Africa
  'pt-ao': 'Angola', 'en-ao': 'Angola',
  'pt-cv': 'Cabo Verde', 'en-cv': 'Cabo Verde',
  'ar-dj': 'Djibouti', 'en-dj': 'Djibouti', 'fr-dj': 'Djibouti',
  'am-et': 'Ethiopia', 'en-et': 'Ethiopia',
  'en-ke': 'Kenya',
  'ar-mr': 'Mauritania', 'en-mr': 'Mauritania', 'fr-mr': 'Mauritania',
  'en-mu': 'Mauritius and Seychelles',
  'en-za': 'South Africa',
  'en-tz': 'Tanzania',
  'en-tg': 'Togo', 'fr-tg': 'Togo',
  'en-ug': 'Uganda',
  'en-zm': 'Zambia',
  'en-zw': 'Zimbabwe',
};

export function isValidLocale(locale: string): boolean {
  return locale in VALID_LOCALES;
}

/** Preferred language priority per country code (native first, then English fallback). */
const LANG_PRIORITY = ['es', 'pt', 'fr', 'it', 'ar', 'ru', 'nl', 'am', 'kk', 'ky', 'uz', 'ht', 'en'];

/**
 * Resolve a 2-letter country code (e.g. 'co', 'pe', 'br') to the best locale.
 * Picks native language first, falls back to English, then any available.
 * Returns null if country code has no locales.
 */
export function resolveLocale(countryCode: string): string | null {
  const cc = countryCode.toLowerCase();
  const matches = Object.keys(VALID_LOCALES).filter((l) => l.endsWith(`-${cc}`));
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0]!;
  // Pick by language priority
  for (const lang of LANG_PRIORITY) {
    const match = matches.find((l) => l.startsWith(`${lang}-`));
    if (match) return match;
  }
  return matches[0]!;
}

/** Get all valid country codes (unique, sorted). */
export function getValidCountryCodes(): string[] {
  const codes = new Set<string>();
  for (const locale of Object.keys(VALID_LOCALES)) {
    codes.add(locale.split('-')[1]!);
  }
  return [...codes].sort();
}
