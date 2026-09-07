import type { GlobalConfig } from 'payload'

import { requireTotpVerified } from '@/access/requireTotpVerified'
import { revalidateGlobalAfterChange } from '@/lib/revalidate'

/**
 * Home-page display settings (FUNCTIONALITY.md §3.1 / §5.3).
 *
 * Currently holds one control: how many service cards the public Home page
 * shows, drawn from the drag order set on the Services admin screen. `0` (the
 * default) means "show all". The Services management view (ServicesView /
 * ServicesManager) reads and writes this via /api/admin/services.
 *
 * No draft workflow — like CompanyInfo this global is always live; a change
 * revalidates the public site so the Home grid updates immediately. Writes are
 * 2FA-gated like every other admin mutation.
 */
export const HomeSettings: GlobalConfig = {
  slug: 'home-settings',
  label: 'Home Page Settings',
  admin: {
    group: 'Settings',
    description:
      'Controls how the public Home page presents content. Managed from the ' +
      'Services screen; changes apply immediately.',
    // Not surfaced in the (custom) admin nav — it is edited inline from the
    // Services management view, not as a standalone screen.
    hidden: true,
  },
  access: {
    // The card count is needed to render the public Home page, so reads are
    // public; writes require the full 2FA step-up like every other mutation.
    read: () => true,
    update: requireTotpVerified(() => true),
  },
  hooks: {
    afterChange: [revalidateGlobalAfterChange],
  },
  fields: [
    {
      name: 'serviceCardLimit',
      type: 'number',
      defaultValue: 0,
      min: 0,
      admin: {
        description:
          'How many service cards to show on the Home page, in the drag order ' +
          'set on the Services screen. 0 = show all.',
      },
    },
  ],
}
