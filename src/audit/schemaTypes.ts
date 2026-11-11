// Shared schema.org helpers for the schema checks.
//
// What the checks kept getting wrong on real pages:
//   1. Nesting. parseJsonLdNodes (templates.ts) flattens the TOP-LEVEL @graph only, so an entity
//      declared under mainEntity / isPartOf / about / department was invisible. Real pages nest
//      constantly (WebPage > mainEntity > Corporation, WebPage > isPartOf > WebSite).
//   2. Whose entity it is. Walking EVERY property overcorrects: an Organization under
//      offers.seller, brand, manufacturer or review.author is somebody else's company, and must not
//      satisfy "this homepage declares its own Organization". So the walk descends only through
//      IDENTITY_EDGES - properties that point at the page's or the site's own entities.
//   3. Types. Matching was a hardcoded handful, exact-case. Organization has a large subtree, pages
//      write "Website" for "WebSite", and some emitters write full IRIs ("https://schema.org/Organization",
//      "schema:WebSite"). typesOf lowercases and strips the vocabulary prefix.
//   4. Caps. The walk is bounded, and a bounded scan that finds nothing has NOT proven absence.
//      scanTypedNodes reports `truncated`, and schemaTypePresence returns 'unknown' rather than 'absent'.

import { parseJsonLdNodes } from './templates.js';

const VOCAB_PREFIX = /^(?:https?:\/\/(?:www\.)?schema\.org\/|schema:)/i;

/** Every @type on a node, lowercased with any schema.org prefix stripped. Handles string or array @type. */
export function typesOf(node: unknown): string[] {
  const t = (node as { '@type'?: unknown } | null)?.['@type'];
  const norm = (x: string): string => x.trim().replace(VOCAB_PREFIX, '').toLowerCase();
  if (typeof t === 'string') return [norm(t)];
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === 'string').map(norm);
  return [];
}

/**
 * Properties that point at the page's or the site's OWN entities. The walk descends only through
 * these (plus arrays and @graph), so third-party entities under offers/seller/brand/manufacturer/
 * review/author/organizer are not mistaken for the site's own Organization.
 */
export const IDENTITY_EDGES = new Set<string>([
  '@graph', 'mainEntity', 'mainEntityOfPage', 'isPartOf', 'publisher', 'about', 'provider',
  'parentOrganization', 'subOrganization', 'department', 'breadcrumb', 'hasPart', 'owner',
]);

const MAX_NODES = 5000;
const MAX_DEPTH = 16;

export interface TypedNodeScan {
  nodes: any[];
  /** True when the walk hit its node or depth bound before finishing. A miss is then NOT proof of absence. */
  truncated: boolean;
}

/**
 * Typed nodes in the JSON-LD: every top-level block and @graph member, plus anything nested under
 * an IDENTITY_EDGES property. Cycle-guarded and bounded; reports `truncated` instead of stopping
 * silently. `stopWhen` ends the walk early (truncated stays false) once the caller has its answer.
 */
export function scanTypedNodes(col: string | null, stopWhen?: (node: any) => boolean): TypedNodeScan {
  const nodes: any[] = [];
  const seen = new Set<unknown>();
  let truncated = false, done = false;
  const walk = (v: unknown, depth: number): void => {
    if (done || v == null || typeof v !== 'object' || seen.has(v)) return;
    if (nodes.length >= MAX_NODES || depth > MAX_DEPTH) { truncated = true; return; }
    seen.add(v);
    if (Array.isArray(v)) { for (const x of v) walk(x, depth); return; }
    const o = v as Record<string, unknown>;
    if (o['@type'] != null) {
      nodes.push(o);
      if (stopWhen?.(o)) { done = true; return; }
    }
    for (const [k, val] of Object.entries(o)) {
      if (IDENTITY_EDGES.has(k) && val && typeof val === 'object') walk(val, depth + 1);
    }
  };
  for (const root of parseJsonLdNodes(col)) walk(root, 0);
  return { nodes, truncated: done ? false : truncated };
}

/** The typed nodes of scanTypedNodes, for callers that only need the list. */
export function collectTypedNodes(col: string | null): any[] {
  return scanTypedNodes(col).nodes;
}

/**
 * Organization and its schema.org subtree, lowercased (schema.org v29, including the LocalBusiness
 * and MedicalBusiness trees). A homepage "has an Organization" if any owned typed node carries one:
 * a solicitor is a LegalService, a shop a ClothingStore, a cafe a CafeOrCoffeeShop.
 */
export const ORGANIZATION_TYPES = new Set<string>([
  'organization', 'airline', 'consortium', 'corporation', 'cooperative',
  'educationalorganization', 'collegeoruniversity', 'elementaryschool', 'highschool', 'middleschool', 'preschool', 'school',
  'fundingscheme', 'governmentorganization', 'librarysystem',
  'medicalorganization', 'diagnosticlab', 'hospital', 'medicalclinic', 'pharmacy', 'physician', 'individualphysician', 'physiciansoffice', 'veterinarycare',
  'ngo', 'newsmediaorganization', 'onlinebusiness', 'onlinestore',
  'performinggroup', 'dancegroup', 'musicgroup', 'theatergroup',
  'politicalparty', 'project', 'fundingagency', 'researchproject', 'researchorganization', 'searchrescueorganization',
  'sportsorganization', 'sportsteam', 'workersunion',
  // LocalBusiness and its subtree
  'localbusiness', 'animalshelter', 'archiveorganization', 'childcare', 'drycleaningorlaundry',
  'emergencyservice', 'firestation', 'policestation',
  'employmentagency', 'governmentoffice', 'postoffice', 'internetcafe', 'library',
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
  'medicalbusiness', 'communityhealth', 'dentist', 'dermatology', 'dietnutrition', 'geriatric', 'gynecologic', 'midwifery', 'nursing',
  'obstetric', 'oncologic', 'optician', 'optometric', 'otolaryngologic', 'pediatric', 'physiotherapy', 'plasticsurgery', 'podiatric',
  'primarycare', 'psychiatric', 'publichealth',
  'sportsactivitylocation', 'bowlingalley', 'exercisegym', 'golfcourse', 'publicswimmingpool', 'sportsclub', 'stadiumorarena', 'tenniscomplex',
  'store', 'autopartsstore', 'bikestore', 'bookstore', 'clothingstore', 'computerstore', 'conveniencestore', 'departmentstore', 'electronicsstore', 'florist', 'furniturestore', 'gardenstore', 'grocerystore', 'hardwarestore', 'hobbyshop', 'homegoodsstore', 'jewelrystore', 'liquorstore', 'mensclothingstore', 'mobilephonestore', 'movierentalstore', 'musicstore', 'officeequipmentstore', 'outletstore', 'pawnshop', 'petstore', 'shoestore', 'sportinggoodsstore', 'tireshop', 'toystore', 'wholesalestore',
]);

/** WebSite, any casing (matching is lowercase). */
export const WEBSITE_TYPES = new Set<string>(['website']);
export const BREADCRUMB_TYPES = new Set<string>(['breadcrumblist']);

export type Presence = 'present' | 'absent' | 'unknown';

/** Whether any owned typed node carries one of `wanted` (lowercase). 'unknown' = the scan was truncated before a match. */
export function schemaTypePresence(col: string | null, wanted: Set<string>): Presence {
  const hit = (n: any): boolean => typesOf(n).some(t => wanted.has(t));
  const scan = scanTypedNodes(col, hit);
  if (scan.nodes.some(hit)) return 'present';
  return scan.truncated ? 'unknown' : 'absent';
}

/** True if any owned typed node carries one of `wanted`. An unknown (truncated) scan counts as not found. */
export function hasSchemaType(col: string | null, wanted: Set<string>): boolean {
  return schemaTypePresence(col, wanted) === 'present';
}

const ORG_OR_WEBSITE = new Set<string>([...ORGANIZATION_TYPES, ...WEBSITE_TYPES]);
export const orgOrWebSitePresence = (col: string | null): Presence => schemaTypePresence(col, ORG_OR_WEBSITE);
export const hasOrganizationSchema = (col: string | null): boolean => hasSchemaType(col, ORGANIZATION_TYPES);
export const hasWebSiteSchema = (col: string | null): boolean => hasSchemaType(col, WEBSITE_TYPES);

/** The site's own Organization-family nodes (owned edges only), for completeness checks. */
export function ownOrganizationNodes(col: string | null): { nodes: any[]; truncated: boolean } {
  const scan = scanTypedNodes(col);
  return { nodes: scan.nodes.filter(n => typesOf(n).some(t => ORGANIZATION_TYPES.has(t))), truncated: scan.truncated };
}
