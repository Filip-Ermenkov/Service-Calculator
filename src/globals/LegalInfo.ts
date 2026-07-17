import type { GlobalConfig } from 'payload'
import { APIError } from 'payload'

import { requireTotpVerified } from '@/access/requireTotpVerified'
import { revalidateGlobalAfterChange } from '@/lib/revalidate'

/**
 * The registration-identity fields that must all be present before the Legal
 * Notice can go live. Per docs/FUNCTIONALITY.md §2.5 and docs/TECHSPEC.md §6.9,
 * this page must never be published with placeholder or invented legal details.
 */
export const REQUIRED_LEGAL_FIELDS = [
  'legalName',
  'legalForm',
  'registeredAddress',
  'rcsNumber',
  'vatNumber',
] as const

/**
 * Pure check (exported for unit testing): given the data being saved, return
 * the list of required legal fields that are missing/blank. Only meaningful
 * when the document is being *published* — callers decide when to enforce.
 */
export function findMissingLegalFields(
  data:
    | Partial<Record<(typeof REQUIRED_LEGAL_FIELDS)[number], unknown>>
    | undefined
    | null,
): string[] {
  if (!data) return [...REQUIRED_LEGAL_FIELDS]
  return REQUIRED_LEGAL_FIELDS.filter((field) => {
    const value = data[field]
    return typeof value !== 'string' || value.trim().length === 0
  })
}

export const LegalInfo: GlobalConfig = {
  slug: 'legal-info',
  label: 'Legal Notice & Privacy',
  admin: {
    group: 'Settings',
    description:
      'Legal Notice and Privacy Policy content. Cannot be published until the ' +
      'real registration details (legal name, form, RCS number, VAT number, ' +
      'registered address) are filled in — see TECHSPEC §6.9.',
  },
  access: {
    // Public content once published. Payload globals return only the published
    // main-row to a normal (no-`draft`) read; unpublished edits live in the
    // versions table, so placeholder drafts are never exposed here. The
    // publish gate below is what guarantees it's never *published* incomplete.
    read: () => true,
    update: requireTotpVerified(() => true),
  },
  // Draft/publish so the page can be authored and held in Draft until the
  // client's real details arrive (FUNCTIONALITY.md §2.5).
  versions: {
    drafts: true,
  },
  hooks: {
    // Publishing the Legal Notice / Privacy Policy revalidates the public pages
    // that render them (and the footer links to them).
    afterChange: [revalidateGlobalAfterChange],
    // Primary, explicit §6.9 safeguard. `required: true` on the fields below
    // already blocks publishing empty values with per-field UI errors (draft
    // saves bypass required, so incomplete drafts are still allowed); this
    // hook is the authoritative, aggregated gate that (a) gives one clear,
    // actionable message and (b) still holds even if a `required` flag is
    // later changed. It only fires when the incoming status is `published`.
    beforeValidate: [
      ({ data }) => {
        if (data?._status === 'published') {
          const missing = findMissingLegalFields(data)
          if (missing.length > 0) {
            throw new APIError(
              `Cannot publish the Legal Notice until these registration details ` +
                `are filled in: ${missing.join(', ')}. Save as a draft instead ` +
                `until the real values are available (see TECHSPEC §6.9).`,
              400,
            )
          }
        }
        return data
      },
    ],
  },
  fields: [
    {
      name: 'legalName',
      type: 'text',
      required: true,
      admin: { description: 'Registered legal name of the company.' },
    },
    {
      name: 'legalForm',
      type: 'text',
      required: true,
      admin: { description: 'e.g. S.à r.l., S.A. — the registered legal form.' },
    },
    {
      name: 'registeredAddress',
      type: 'textarea',
      required: true,
      admin: { description: 'Registered office address.' },
    },
    {
      name: 'rcsNumber',
      type: 'text',
      required: true,
      label: 'RCS Luxembourg number',
    },
    {
      name: 'vatNumber',
      type: 'text',
      required: true,
      label: 'VAT number',
    },
    {
      name: 'legalContactEmail',
      type: 'email',
      admin: { description: 'Contact email for legal enquiries.' },
    },
    {
      // Localized: the privacy policy prose is authored in EN and translated to
      // FR/DE (the translation pipeline lands in Phase 5).
      name: 'privacyPolicyContent',
      type: 'richText',
      localized: true,
      admin: { description: 'Privacy Policy body (rich text).' },
    },
  ],
}
