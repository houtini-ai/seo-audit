// Shared schema.org helpers for the schema checks.
//
// Two things the checks kept getting wrong on real pages:
//   1. Nesting. parseJsonLdNodes (templates.ts) flattens the TOP-LEVEL @graph only, so an entity
//      declared under mainEntity / isPartOf / about / provider / department / @graph-deeper was
//      invisible. Real pages nest constantly (e.g. WebPage > mainEntity > Corporation, WebPage >
//      isPartOf > WebSite). collectTypedNodes walks the whole tree.
//   2. Types. Matching was a hardcoded handful, exact-case. But Organization has a large subtree
//      (Corporation, LocalBusiness and all its subtypes, LegalService, Restaurant, Store...), and
//      pages write "Website" for "WebSite" and vary casing freely. ORGANIZATION_TYPES covers the
//      subtree, and all matching here is lowercase.

import { parseJsonLdNodes } from './templates.js';

/** Every @type on a node, lowercased. Handles @type as a string or an array. */
export function typesOf(node: unknown): string[] {
  const t = (node as { '@type'?: unknown } | null)?.['@type'];
  if (typeof t === 'string') return [t.toLowerCase()];
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === 'string').map(x => x.toLowerCase());
  return [];
}

/**
 * Every typed node in the JSON-LD, however deeply nested. Starts from parseJsonLdNodes (top-level
 * blocks + top @graph) and descends through all object/array values, so a typed entity nested
 * under any property is found. Cycle-guarded and bounded (node count + depth) against pathological
 * documents. `@context` is never descended into (it isn't data).
 */
export function collectTypedNodes(col: string | null): any[] {
  const out: any[] = [];
  const seen = new Set<unknown>();
  const MAX_NODES = 2000;
  const walk = (v: unknown, depth: number): void => {
    if (out.length >= MAX_NODES || depth > 16 || v == null || typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) { for (const x of v) walk(x, depth); return; }
    const o = v as Record<string, unknown>;
    if (o['@type'] != null) out.push(o);
    for (const [k, val] of Object.entries(o)) {
      if (k === '@context') continue; // metadata, not an entity
      if (val && typeof val === 'object') walk(val, depth + 1);
    }
  };
  for (const root of parseJsonLdNodes(col)) walk(root, 0);
  return out;
}

/**
 * Organization + its full schema.org subtree, lowercased. A page "has an Organization" (for the
 * knowledge-panel / sitelinks purpose the homepage check serves) if any typed node carries one of
 * these - a solicitor is a LegalService, a shop a Store/ClothingStore, a cafe a CafeOrCoffeeShop,
 * and each is still an Organization. Source: the schema.org Organization and LocalBusiness trees.
 */
export const ORGANIZATION_TYPES = new Set<string>([
  'organization', 'airline', 'consortium', 'corporation', 'cooperative',
  'educationalorganization', 'collegeoruniversity', 'elementaryschool', 'highschool', 'middleschool', 'preschool', 'school',
  'fundingscheme', 'governmentorganization', 'librarysystem',
  'medicalorganization', 'diagnosticlab', 'hospital', 'medicalclinic', 'pharmacy', 'physician', 'veterinarycare',
  'ngo', 'newsmediaorganization', 'onlinebusiness', 'onlinestore',
  'performinggroup', 'dancegroup', 'musicgroup', 'theatergroup',
  'politicalparty', 'projectorganization', 'researchorganization', 'searchrescueorganization',
  'sportsorganization', 'sportsteam', 'workersunion',
  // LocalBusiness and its subtree
  'localbusiness', 'animalshelter', 'archiveorganization', 'childcare', 'drycleaningorlaundry',
  'emergencyservice', 'firestation', 'policestation',
  'employmentagency', 'governmentoffice', 'internetcafe', 'library',
  'legalservice', 'attorney', 'notary',
  'professionalservice', 'radiostation', 'realestateagent', 'recyclingcenter', 'selfstorage',
  'shoppingcenter', 'televisionstation', 'touristinformationcenter', 'travelagency',
  'automotivebusiness', 'autobodyshop', 'autodealer', 'autorental', 'autorepair', 'autowash', 'gasstation', 'motorcycledealer', 'motorcyclerepair',
  'entertainmentbusiness', 'adultentertainment', 'amusementpark', 'artgallery', 'casino', 'comedyclub', 'movietheater', 'nightclub',
  'financialservice', 'accountingservice', 'automatedteller', 'bankorcreditunion', 'insuranceagency',
  'foodestablishment', 'bakery', 'barorpub', 'brewery', 'cafeorcoffeeshop', 'distillery', 'fastfoodrestaurant', 'icecreamshop', 'restaurant', 'winery',
  'healthandbeautybusiness', 'beautysalon', 'dayspa', 'hairsalon', 'healthclub', 'nailsalon', 'tattooparlor',
  'homeandconstructionbusiness', 'electrician', 'generalcontractor', 'hvacbusiness', 'housepainter', 'locksmith', 'movingcompany', 'plumber', 'roofingcontractor',
  'lodgingbusiness', 'bedandbreakfast', 'campground', 'hostel', 'hotel', 'motel', 'resort', 'skiresort', 'vacationrental',
  'medicalbusiness', 'dentist', 'dermatology', 'optician',
  'sportsactivitylocation', 'bowlingalley', 'exercisegym', 'golfcourse', 'publicswimmingpool', 'sportsclub', 'stadiumorarena', 'tenniscomplex',
  'store', 'autopartsstore', 'bikestore', 'bookstore', 'clothingstore', 'computerstore', 'conveniencestore', 'departmentstore', 'electronicsstore', 'florist', 'furniturestore', 'gardenstore', 'grocerystore', 'hardwarestore', 'hobbyshop', 'homegoodsstore', 'jewelrystore', 'liquorstore', 'mensclothingstore', 'mobilephonestore', 'movierentalstore', 'musicstore', 'officeequipmentstore', 'outletstore', 'pawnshop', 'petstore', 'shoestore', 'sportinggoodsstore', 'tireshop', 'toystore', 'wholesalestore',
]);

/** WebSite, and the common "Website" mis-casing. Matching is lowercase, so this covers both. */
export const WEBSITE_TYPES = new Set<string>(['website']);

/** True if any typed node (nested included) belongs to the Organization family. */
export function hasOrganizationSchema(col: string | null): boolean {
  return collectTypedNodes(col).some(n => typesOf(n).some(t => ORGANIZATION_TYPES.has(t)));
}

/** True if any typed node (nested included) declares a WebSite, any casing. */
export function hasWebSiteSchema(col: string | null): boolean {
  return collectTypedNodes(col).some(n => typesOf(n).some(t => WEBSITE_TYPES.has(t)));
}

/** True if any typed node (nested included) carries one of `wanted` (pass lowercase types). */
export function hasSchemaType(col: string | null, wanted: Set<string>): boolean {
  return collectTypedNodes(col).some(n => typesOf(n).some(t => wanted.has(t)));
}
