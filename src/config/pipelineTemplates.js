/**
 * Pipeline templates by industry (M09). A new workspace gets the template for its onboarding
 * industry; admins can pick any template when adding a pipeline. Every pipeline also gets the two
 * system stages Won and Lost, always last.
 *
 * The `default` template must match the backfill in migration 20261019180000_pipelines_deals.
 */

/** Spread win probabilities evenly over n open stages, ending at 80 % (4 stages → 20/40/60/80). */
const spread = (names, rottingDays = 7) =>
  names.map((name, i) => ({ name, probability: Math.round(((i + 1) * 80) / names.length / 5) * 5, rottingDays }))

export const PIPELINE_TEMPLATES = {
  default: { name: 'Sales pipeline', industry: null, stages: [
    { name: 'New', probability: 10, rottingDays: 7 },
    { name: 'Qualified', probability: 30, rottingDays: 7 },
    { name: 'Proposal sent', probability: 60, rottingDays: 7 },
    { name: 'Negotiation', probability: 80, rottingDays: 7 },
  ] },
  retail: { name: 'Sales pipeline', industry: 'Retail & distribution', stages: spread(['New enquiry', 'Sample/visit', 'Quotation sent', 'Negotiation']) },
  manufacturing: { name: 'Sales pipeline', industry: 'Manufacturing', stages: spread(['RFQ received', 'Technical discussion', 'Quotation sent', 'Negotiation', 'PO pending'], 10) },
  services: { name: 'Sales pipeline', industry: 'Professional services', stages: spread(['Discovery', 'Proposal sent', 'Negotiation', 'Contract sent'], 10) },
  real_estate: { name: 'Sales pipeline', industry: 'Real estate', stages: spread(['Enquiry', 'Site visit scheduled', 'Site visit done', 'Negotiation', 'Booking'], 5) },
  education: { name: 'Admissions', industry: 'Education', stages: spread(['Enquiry', 'Counselling', 'Application', 'Fee pending']) },
  healthcare: { name: 'Sales pipeline', industry: 'Healthcare', stages: spread(['Enquiry', 'Consultation', 'Proposal', 'Negotiation']) },
}

export const TEMPLATE_LABELS = {
  default: 'General sales',
  retail: 'Retail & distribution',
  manufacturing: 'Manufacturing',
  services: 'Professional services',
  real_estate: 'Real estate',
  education: 'Education admissions',
  healthcare: 'Healthcare',
}

/** Template for an onboarding industry ("Other" and unknown → default). */
export function templateForIndustry(industry) {
  const entry = Object.entries(PIPELINE_TEMPLATES).find(([, t]) => t.industry && t.industry === industry)
  return entry ? entry[0] : 'default'
}

export function templateCatalogue() {
  return Object.entries(PIPELINE_TEMPLATES).map(([key, t]) => ({ key, label: TEMPLATE_LABELS[key], name: t.name, stages: t.stages }))
}
