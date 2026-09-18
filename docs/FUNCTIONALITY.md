# Functionality Specification — bulbau.lu

> This document describes the complete functionality of the bulbau.lu website from a non-technical perspective. It covers every page, every user-facing interaction, every admin capability, and all cross-cutting behaviours. It is intended to serve as the single source of truth before any technical decisions are made.
>
> **Status (2026-09-18) — read this first.** **Every feature described in this document is built and running at `https://bulbau.lu`**, which is deliberately not yet announced or indexed. Where the build deviates from the wording below, a short **Built** note follows the relevant section.
>
> **Since the last update (2026-09-18, awaiting its test-then-live release):** a review of the whole build found and closed four gaps that no feature had asked for — (1) an **unpublished Legal Notice draft could be read by anyone** who asked the website's data interface for "the draft" (the pages themselves were fine; the raw interface was not) — closed, so placeholder legal details can no longer surface anywhere before the admin publishes (§2.5); (2) someone holding only the admin **password**, without the authenticator code, could read every unpublished draft through the version-history interface — now the second factor is required there too (§5.1); (3) **photos are capped at 4 MB** with a clear message in the admin — a larger photo used to upload "successfully" and then fail to display for visitors (§5.3–5.5) — and photos are now cached at the edge, so pages load faster; (4) an unused query interface was switched off. All third-party software updates were applied and every automated security-scan finding resolved. **Since 2026-09-16/17:** the **admin's "Forgot your password?" really sends an email** (§5.1); the admin login is protected against being replayed from another website; the Careers page's "Contact Us" button goes to the Contact page. **Both the test and live databases were rebuilt from empty on 2026-09-16** — the live site's content (services, projects, company details) has to be re-entered.
>
> **What still stands between the site and a public launch — none of it development work:** the company's real registered legal details entered and published (a safeguard prevents publishing placeholders — §2.5); the client's `office@bulbau.lu` mailbox connected to the domain, so the contact form has somewhere to deliver; AWS "production access" for email so the emailed quote can reach any visitor's address (until then only pre-verified addresses receive it); and the "make it findable by search engines" switch, flipped last.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Global Behaviour](#2-global-behaviour)
   - 2.1 Language Switching
   - 2.2 Responsive Design
   - 2.3 Navigation Header
   - 2.4 Footer
   - 2.5 Legal & Privacy
3. [Public Pages](#3-public-pages)
   - 3.1 Home Page
   - 3.2 Projects Page
   - 3.3 Service Page (Calculator)
   - 3.4 About Us Page
   - 3.5 Careers Page
4. [PDF Quote](#4-pdf-quote)
5. [Admin Panel](#5-admin-panel)
   - 5.1 Authentication
   - 5.2 Dashboard
   - 5.3 Services Management
   - 5.4 Projects Management
   - 5.5 Careers Management
   - 5.6 About Us & Company Info Management
   - 5.7 Translation Management
   - 5.8 Account Settings
6. [Content & Translation Lifecycle](#6-content--translation-lifecycle)
7. [Edge Cases & Constraints](#7-edge-cases--constraints)

---

## 1. Overview

bulbau.lu is a multilingual, content-managed company website for a service business operating in Luxembourg. It serves two distinct audiences:

- **Visitors** — prospective customers who browse services, view completed projects, read about the company, and generate estimated price quotes for services they are interested in.
- **The Administrator** — a single company staff member who manages all website content through a private admin panel without requiring any coding knowledge.

The site is available in **French**, **German**, and **English**. The domain is `bulbau.lu`.

---

## 2. Global Behaviour

### 2.1 Language Switching

- A language selector is permanently visible in the header on every page.
- Visitors can switch between French (FR), German (DE), and English (EN) at any time.
- Switching language reloads the current page in the selected language; the visitor stays on the same page they were on.
- The selected language is reflected in the page's web address (e.g. a French visitor browses `/fr/...` pages) and stays consistent as they navigate the site. First-time visitors are shown the language that best matches their browser/device setting by default. This also ensures each language version of the site can be found directly through search engines.
- All user-facing text on the site — navigation labels, page content, service descriptions, button labels, form labels, error messages, PDF content, and disclaimer text — is displayed in the selected language.
- Content is authored by the admin in English and automatically translated into French and German. The admin can review and manually override any individual translated string (see Section 6).

### 2.2 Responsive Design

- The website works on all screen sizes: desktop, tablet, and mobile.
- On smaller screens, the navigation collapses into a hamburger menu that expands when tapped.
- All grids (services, projects, job listings) reflow to fewer columns on smaller screens.

### 2.3 Navigation Header

The header appears on every public page and contains:

- **Company logo** — links back to the Home page.
- **Home** — navigates to the Home page.
- **Projects** — navigates to the Projects page.
- **About Us** — navigates to the About Us page.
- **Careers** — navigates to the Careers page.
- **Language selector** — switches between FR, DE, EN.

Services are not a top-level navigation item. Visitors discover and access individual services via the Home page.

### 2.4 Footer

The footer appears on every public page and contains, at minimum:

- Company name and logo.
- Quick links to all main pages (Home, Projects, About Us, Careers).
- Key contact details (phone number, email address).
- Links to the company's Facebook and Instagram profiles.
- Links to the Privacy Policy and Legal Notice pages (see Section 2.5).
- Copyright notice.

---

### 2.5 Legal & Privacy

Every page's footer links to two pages: a **Privacy Policy** and a **Legal Notice**. Both are managed as admin-editable content, the same way the About Us page is, since their content (registration details, data practices) can change over time and shouldn't require a developer to update.

**Legal Notice** displays the company's registered legal name and form, registered office address, company registration number (RCS Luxembourg), VAT number, and a contact email for legal enquiries.

**Privacy Policy** explains, in plain language:
- What personal data is collected and why: contact form submissions (name, email, phone, subject, message) and, separately, an email address when a visitor asks to receive a PDF quote by email.
- That submissions are relayed by email and never stored in a database; that PDF quotes are generated on request and never stored (see Sections 3.3 and 4).
- That submitted messages are kept only as long as needed to respond, then deleted in the course of normal business practice.
- How a visitor can contact the company to ask what data is held about them or to request its deletion.

**No cookie-consent banner** is shown to visitors. The site runs no web analytics, so the only cookie in use remembers the visitor's chosen language (strictly functional) — which requires no consent under GDPR/ePrivacy rules. (Web analytics was deliberately left out of scope; see `docs/TECHSPEC.md` §6.10. If ever added, it must be a cookieless tool so no banner is needed.)

**Important constraint**: the company's exact registered legal form, RCS Luxembourg number, VAT number, and registered office address are not yet finalized. The Legal Notice must not be published with placeholder or invented values in place of these — the admin fills them in when they're available, and the page stays in Draft until it is complete and accurate.

> **Built.** Publishing is technically blocked until all five details are present, and — since 2026-09-18 — an unpublished draft is invisible to the public on *every* path, including the website's raw data interface (it previously returned the draft when asked for it explicitly). The admin can therefore save partial details as a draft at any time without risk.

---

## 3. Public Pages

### 3.1 Home Page

#### Purpose
The primary landing page. It introduces the company and provides direct access to each of the company's services.

#### Layout & Content

**Hero / Banner Section**
- A prominent visual area at the top of the page with a headline and a short company tagline or introduction.

**Services Section**
- Displays a grid of service cards. The number of cards shown is controlled by the admin. **(✅ Built 2026-09-07 — the admin sets this on the Services screen; leaving it at 0 shows every published service. Until then this was the one item in this document with no implementation behind it.)**
- Each card contains:
  - A photo (set by the admin).
  - A service title.
  - A brief description (1–3 sentences).
- **Hover behaviour**: when a visitor hovers over a card, a visual animation plays (e.g., a subtle lift, colour overlay, or zoom effect on the image) to signal it is clickable.
- Clicking a service card navigates to that service's dedicated page (see Section 3.3).

---

### 3.2 Projects Page

#### Purpose
Showcases the company's portfolio of completed work to build trust with prospective customers.

#### Layout & Content

**Filter & Search Bar**
- A search bar at the top allows visitors to search projects by keyword (title or description).
- A filter control allows visitors to narrow projects by service category (e.g., show only projects related to a specific service type). The available filter categories reflect the services that exist in the system.
- Filters and search can be combined.
- Results update immediately as the visitor types or selects a filter (no page reload required).
- If no projects match the search or filter, a friendly "no results" message is shown.

**Projects Grid**
- Displays matching projects as a grid of cards.
- Each card contains:
  - A photo.
  - A project title.
  - A brief description.
  - A completion date.
- Cards are sorted by completion date, newest first, by default.

  > **🔁 Updated 2026-09-14.** The order is now the one the admin sets by **dragging projects** in the admin list (see §5.4). A new project is inserted at the top, so with no dragging the page still reads newest first; dragging lets the admin pin a showcase project above newer ones.
- If there are many projects, the page uses pagination or a "load more" button to avoid an excessively long page.

---

### 3.3 Service Page (Price Calculator)

#### Purpose
Each service has its own dedicated page. It explains the service and lets the visitor generate an estimated price quote by filling in a set of parameters. The visitor can then download or email themselves the quote as a PDF.

Because different services have entirely different parameters (e.g., roof area and panel count for solar; dimensions and materials for something else), each service page is generated dynamically from the configuration the admin has set up for that service.

#### Layout & Content

**Service Header**
- Service title and a detailed description of what the service involves.
- A service-specific hero image.

**Estimate Disclaimer (prominent)**
- A clearly visible notice — displayed before and after the calculator — stating that all prices generated are **estimates only**, that the actual price may differ, and that the visitor should contact the company for a precise quotation.
- The company's phone number and email address are shown alongside this disclaimer so the visitor can act immediately.

**Price Calculator Form**
- A form containing the input fields that the admin has defined for this service.
- Each field has a label and a type appropriate to its data (e.g., a number input for area in m², a dropdown for material grade, a toggle for an optional add-on). **(✅ Extended 2026-09-07: the admin can also give a number field a **unit** shown next to it — "m²", "kW" — which appears on screen and in the PDF but never affects the maths, and can set a yes/no toggle to start switched **on**.)**
- As the visitor fills in or adjusts any field, the estimated total price updates in real time on the screen — no submit button is needed for the price to recalculate.
- The estimated price is displayed prominently, formatted as a currency amount.

> **Built.** Number / dropdown / yes-no fields as the admin defined them (a number field can carry a unit such as "m²"; a toggle can start switched on); the total recomputes on every change and is formatted in euros for the current language (`€1,234.50` / `1.234,50 €`), with an itemised breakdown. The total is **held back with a short prompt until every required (\*) field has a value** (a typed **0 counts**), and a formula that yields zero, a negative or an undefined amount shows **"Contact us for a price"** instead of a number (§7). The same pricing engine produces the PDF, so the two can never disagree.

**Quote Actions**
- Once the visitor has filled in the form, two action buttons are available:
  - **Download PDF** — immediately downloads a PDF quote to the visitor's device (see Section 4).
  - **Send to Email** — opens a small prompt asking for an email address, then sends the PDF to that address. No other data is collected or stored. The company is not notified.
- Both actions are available regardless of whether the visitor has filled in every field; however, any empty or invalid field is clearly indicated before the PDF is generated.

---

### 3.4 About Us Page

#### Purpose
Introduces the company, its history, values, and team, and provides a way for visitors to get in touch directly.

#### Layout & Content

**Company Information Section**
- A rich text block containing the company's story, activities, values, or any other information the admin chooses to write.
- This content is fully editable by the admin.

**Contact Details**
- Phone number (click-to-call on mobile).
- Email address (click-to-compose).
- Facebook profile link (opens in a new tab).
- Instagram profile link (opens in a new tab).

**Contact Form**

> **Built — as a dedicated "Contact" page, not on the About page** (linked from the navigation, the footer and the Home buttons; the About page keeps its contact-details panel). Fields: name, email, subject (optional), message — there is no phone field. The message is relayed straight to the company's inbox and **never stored** on the website. Spam protection is Cloudflare Turnstile (a mostly-invisible human check, switched on in both environments) plus a hidden honeypot field and per-visitor throttling. Until `Company Info → Email` is a real, verified mailbox the form cannot deliver: the visitor is shown an error asking them to phone or email instead, so no message is silently lost. The Legal/Privacy publish gate (§2.5) still applies before public launch.

- A form with the following fields:
  - Name (text, required).
  - Email address (required, validated as a valid email format).
  - Phone number (text, optional).
  - Subject (text, required).
  - Message (multi-line text area, required).
- A **Send** button submits the form.
- On submission, the message is sent directly to the company's configured email address.
- After successful submission, the visitor sees a confirmation message on screen ("Your message has been sent. We will get back to you shortly.").
- If submission fails, the visitor sees an error message and is asked to try again or use the phone or email contact instead.
- Basic spam protection is applied (e.g., a CAPTCHA or honeypot technique) — invisible to the visitor in the normal case. **(Built: Cloudflare Turnstile — a privacy-friendly, mostly-invisible human check — plus a hidden honeypot field and per-IP rate limiting.)**

---

### 3.5 Careers Page

#### Purpose
Lists open job positions so that interested candidates can see what roles are available and then contact the company to apply.

#### Layout & Content

**Job Listings Grid**
- Displays all active job openings as a grid of cards.
- Each card contains:
  - A photo (e.g., a role-relevant or team photo, set by the admin).
  - A job title.
  - A description of the role and any key requirements.
- Cards are shown in the order the admin has arranged them.

**Application Instructions**
- A visible note on the page (or on each card) informing candidates that to apply, they should contact the company directly — for example by using the Contact page or by calling or emailing.
- There is no online application form.

> **Built.** The notice names the company email and phone (from Company Info); the page's "Contact Us" button opens the Contact page (§3.4).

**Empty State**
- If there are no active job openings, the page displays a friendly message ("There are currently no open positions. Check back later or contact us — we are always open to great people.").

---

## 4. PDF Quote

A PDF quote is generated whenever a visitor requests one from a service page. It is produced entirely on demand and is never stored on the server.

> **Built (both delivery options).** Every service page with a calculator has **"Download PDF quote"** and **"Email me the quote"**. The PDF is produced on demand in the visitor's language, never stored, and contains everything listed below; the emailed copy goes out from `info@bulbau.lu` with a short note that the quote is an estimate, after the same human check as the contact form, and falls back to "download instead" if sending fails (§7). **Until AWS grants the account "production access" for email, the emailed quote only reaches addresses that were pre-verified** — that request is on the launch list. Locally (no PDF service) the same document is shown as a print-ready web page.

### Contents of the PDF

1. **Header**
   - Company logo.
   - Company name.
   - Company contact details: phone number, email address.

2. **Estimate Disclaimer**
   - A prominent notice that this quote is an automated estimate only and does not constitute a binding offer. The visitor must contact the company to receive an accurate and final price.

3. **Service Title & Date**
   - The name of the service being quoted.
   - The date the quote was generated.

4. **Selected Parameters & Line Items**
   - A table or list showing each input field the visitor filled in, its label, the value they entered, and the contribution of that field to the total price (where applicable).

5. **Total Estimated Price**
   - The calculated total, displayed prominently, formatted as a currency amount.

6. **Footer**
   - Company contact details repeated.
   - A note inviting the visitor to get in touch for a precise quote.

### Delivery

- **Download**: the PDF is generated and immediately downloaded to the visitor's device.
- **Email**: the visitor is prompted to enter an email address. The PDF is then sent as an email attachment to that address. The email comes from the company's configured sending address, and the body of the email contains a brief, friendly message (in the visitor's selected language) reiterating that the quote is an estimate and inviting them to contact the company.

### Language

The entire PDF is produced in the language the visitor had selected on the website at the time of generation.

---

## 5. Admin Panel

The admin panel is a private, password-protected section of the website accessible only to the administrator. It is not linked from any public page.

### 5.1 Authentication

#### Login Screen
- Fields: email address and password.
- On submitting valid credentials, the admin is prompted for a **one-time code** from their Google Authenticator app (two-factor authentication).
- On successful two-factor verification, the admin is taken to the dashboard.
- Failed login attempts display a generic error message ("Invalid credentials") without specifying which field was wrong.
- After a defined number of consecutive failed attempts, the login form is temporarily locked and the admin must wait before trying again.

#### Forgotten Password
- A "Forgot your password?" link on the login screen.
- The admin enters their email address and receives a password reset link by email.
- The reset link expires after a set period (e.g., one hour).
- Following the link, the admin sets a new password and is then returned to the login screen.

> **Built (2026-09-16).** The reset email is sent from `info@bulbau.lu` (confirmed delivered 2026-09-17). It contains only a single-use link that expires after **one hour**; the screen shows the same "Email Sent" message whether or not the address has an account, so nobody can use it to discover admin addresses; and repeated requests are throttled (5 per 15 minutes). After choosing a new password the admin still has to enter the two-factor code — a reset never skips it. The "Change Password" and "re-link authenticator" flows in §5.8 are Payload's account screen and the `/admin/totp-setup` screen respectively. **The two-factor code protects everything, including history (2026-09-18):** a session that has entered only the password can neither read unpublished drafts through the version history nor start a photo upload — every such door opens only after the authenticator code.

---

### 5.2 Dashboard

> **✅ Built as a bespoke screen (2026-09-07).** The admin panel no longer looks like a generic CMS: it now has the company's own branding on the login screen and in the sidebar, a purpose-built dashboard with at-a-glance counts and quick actions, a redesigned navigation grouped by area, and a "View website" button in the top bar on every screen. Everything described in this section still holds — it simply looks and reads like part of bulbau.lu rather than an off-the-shelf tool.

After logging in, the admin sees a dashboard with quick links to each management area:

- Services
- Projects
- Careers
- About Us & Company Info
- Translations
- Account Settings

---

### 5.3 Services Management

This is the most flexible and powerful section of the admin panel. Services are the core product offering of the company. The admin has full control over how many services exist, what they are called, how they look, and — critically — how their prices are calculated.

#### Service List

> **✅ Built as a dedicated Services screen (2026-09-07), then moved onto the standard list (2026-09-14).** Everything described below is there — the list with name, status and Edit / Delete / **Preview** buttons, drag-to-reorder, the New Service button — plus the **Home page card count** control (§3.1) edited right under the list. Since 2026-09-14 the Services list is the same standard list every other section uses (Projects, Careers, Media all look and behave the same), which also brings **multi-select with bulk actions** (tick several rows → Edit / Publish / Unpublish / Delete), search and pagination. The old `/admin/services` address simply forwards to it.

- Shows all existing services in a list.
- Each row shows the service name, its published/draft status, and action buttons: **Edit**, **Delete**, **Preview**.
- A **New Service** button opens the service editor for a brand-new service.
- The admin can reorder services using drag-and-drop; this order determines the sequence of cards on the Home page.

#### Service Editor (Create / Edit)

**Basic Information**
- Service title (text).
- Service description (rich text — supports paragraphs, bold, lists, etc.).
- Hero image upload.
- Published / Draft toggle. Draft services are not visible to visitors.

> **Photos, everywhere in the admin (2026-09-18):** JPEG, PNG or WebP, **at most 4 MB each** — the admin sees the file's size and the limit if a photo is larger. A photo above that size used to upload without complaint and then not display for visitors, so this is a safeguard, not a restriction on quality (a full-width 1600 px photo is well under 1 MB).

**Home Page Card**
- Separate card photo (may differ from the hero image).
- Card title (auto-filled from the service title but can be overridden).
- Card brief description (short text, shown in the tile on the Home page).

**Calculator Field Builder**
- The admin defines the input fields that will appear in the price calculator for this service.
- For each field the admin can:
  - Set a **field label** (the name the visitor sees, e.g., "Roof area").
  - Set the **field type**: number input, dropdown (with admin-defined options), toggle (yes/no).
  - For dropdown fields, define the list of selectable options and the value associated with each.
  - Define whether the field contributes **positively** (adds to the price) or **negatively** (subtracts from the price).
  - Set a **unit price / multiplier**: the amount by which the field's value is multiplied to produce its contribution to the total.
  - Mark the field as required or optional.
  - Set a display order (fields can be reordered by drag-and-drop).

**Formula Builder**
- Beyond individual field multipliers, the admin defines how all fields combine into the final total.
- The formula builder provides a structured interface where the admin can:
  - Specify the **order of operations** — which calculations happen first.
  - Define **groupings** — e.g., "(Field A + Field B) × Field C".
  - Add **fixed costs** — flat amounts added to or subtracted from the total regardless of inputs.
  - Add **percentage-based adjustments** — e.g., "apply 10% VAT to the subtotal".
- The formula builder uses a visual, structured interface (not raw code) so that a non-technical admin can construct complex pricing logic without programming knowledge.
- A **live preview** in the editor lets the admin enter sample values and see the calculated result, to verify the formula is working as intended before publishing.

> **✅ Built in Phase 3 part 2 (2026-07-20) — and rebuilt on 2026-09-14 so that ANY formula can be written.** The **Calculator Field Builder** above is the native field editor in the `Services` form (add/reorder fields; set label, type, options, unit price, +/− sign, required; each field also has a short **field key** such as `roof_area`, which is the name the formula uses — keys must be unique within a service and contain no spaces). The **Formula Builder** is a **formula bar**: the admin types (or clicks together) an ordinary calculation over those keys — `area × rate + 200`, `(area × rate + 200) × (1 + 17%)` for VAT, `if(area > 100, area × 10, area × 12)` for a cheaper rate above a threshold, `max(area × 12, 500)` for a minimum charge, `min(…, 5000)` for a cap, `ceil(area / 1.7) × 250` for whole panels, `rush × 200` for a yes/no option (a toggle counts as 1 or 0; a dropdown counts as its option's value). Brackets control the order; `× ÷ − ≤ ≥ ≠` or the keyboard forms `* / - <= >= !=` both work; decimals use a dot. Below the bar the formula is read back **in words** using the fields' labels ("Roof area × Price per m² + 200") so a typo is obvious, and every mistake is explained in plain language at the exact spot ("Unknown field "aera". Did you mean "area"?", "Missing a closing bracket )", "Use a dot for decimals: write "1.5", not "1,5""). Chips insert any field, operator or function without typing; **Start from the default sum** prefills the formula the calculator uses when none is set; a built-in reference lists recipes. A **live preview** tab runs sample values through the very same calculation visitors get (including the "fill the required fields" hold-back and the "Contact us for a price" fallback). Leaving the formula empty is still valid (each field's own unit price is added up). **A formula with an error cannot be published** — Publish is refused with the message on the field, and the unfinished text is kept so nothing is lost; likewise a formula that refers to a field key that was renamed or removed blocks publishing until it is updated. Formulas made with the earlier click-to-add builder open in the bar unchanged.

---

### 5.4 Projects Management

#### Project List
- Shows all projects in a list with their title, completion date, associated service category, and action buttons: **Edit**, **Delete**.
- A **New Project** button opens the project editor.

> **🔁 Updated 2026-09-14.** Same standard list as Services: **drag-and-drop ordering** (this order is the order of the cards on the public Projects page, §3.2 — a new project goes to the top) and **multi-select with bulk actions** (Edit / Publish / Unpublish / Delete).

#### Project Editor (Create / Edit)
- Project title (text).
- Project description (rich text).
- Photo upload.
- Completion date (date picker).
- Associated service category (dropdown — selects one of the existing services; used for filtering on the public Projects page).
- Published / Draft toggle.

---

### 5.5 Careers Management

#### Job Listing List
- Shows all job openings (active and archived) with their title and status.
- Action buttons: **Edit**, **Delete**, **Archive / Restore**.
- A **New Job Opening** button opens the job editor.
- The admin can reorder listings by drag-and-drop; this order determines the display order on the public Careers page.

> **🔁 Updated 2026-09-14.** Same standard list as Services and Projects, with **multi-select and bulk actions**. The **Media** library (photos) uses it too: drag to arrange, tick several files to delete them at once.

#### Job Editor (Create / Edit)
- Job title (text).
- Job description (rich text — role summary, responsibilities, requirements, etc.).
- Photo upload.
- Active / Archived toggle. Archived listings are not shown to visitors.

---

### 5.6 About Us & Company Info Management

This section is split into two parts.

#### About Us Page Content
- A rich text editor where the admin writes the company story, activities, and values.
- Changes saved here are immediately reflected on the public About Us page.

#### Company Information
- A set of individual editable fields:
  - Email address (used for the contact form destination and for display on the site).
  - Phone number.
  - Facebook profile URL.
  - Instagram profile URL.
- These values are used across the entire site wherever contact details appear (header, footer, About Us page, service page disclaimer, PDF quotes).
- Changing any of these fields updates every location where they appear.

---

### 5.7 Translation Management

Because content is authored in English and auto-translated, there will inevitably be cases where the machine translation of a specific string is incorrect or unnatural. This section allows the admin to review and fix translations.

> **Built.** Content saved in English is translated to French and German automatically on save, and the **Translation Management** screen at `/admin/translations` lists every translatable string with its English source beside the current French and German, each marked "Translated" or "Needs translation". Short text is corrected inline (typing a value saves it as a manual override that takes effect immediately; "Re-translate" regenerates the machine translation); longer rich text opens in the normal editor for that language. **Deliberately deferred:** the screen does not yet distinguish a machine translation from a manual override, and does not flag "needs review" automatically when the English changes under an override (that needs an extra behind-the-scenes record per string). Manual overrides also still work by switching the admin's language and editing a field directly.

#### Translation Overview
- A searchable list of every translatable string on the site: page content blocks, field labels, button text, disclaimer notices, email templates, PDF text, and system messages.
- Each entry shows:
  - The original English string.
  - The auto-generated French translation.
  - The auto-generated German translation.
  - Whether any manual overrides exist for that string.

#### Editing a Translation
- The admin clicks any string to open a translation editor.
- The editor shows the English original (read-only) alongside editable text fields for French and German.
- The admin can type a corrected translation and save it.
- Once saved, the manual override takes effect immediately and the auto-translation is no longer used for that string.
- The admin can also reset a manually overridden string back to the auto-translation at any time.

#### Automatic Re-translation
- When the admin edits source content (e.g., updates a service description), the auto-translation for that content is regenerated automatically.
- Any manual overrides for strings that have changed are flagged as "needs review" so the admin knows to check whether their override still makes sense in the context of the updated source.

---

### 5.8 Account Settings

- **Change Password**: the admin enters their current password and a new password twice. On save, the new password takes effect immediately and the admin is asked to log in again.
- **Two-Factor Authentication**: instructions and a QR code to set up or re-link Google Authenticator if the admin changes devices.

---

## 6. Content & Translation Lifecycle

The following describes how content flows from creation to public display in all three languages:

1. The admin creates or edits content in English (e.g., writes a new service description).
2. On saving, the system automatically generates French and German translations of the new or changed content.
3. The translated content is immediately live on the public site in all three languages.
4. If any translation is incorrect or unnatural, the admin navigates to Translation Management, finds the string, and enters a manual correction.
5. The manual correction is stored and used instead of the auto-translation going forward.
6. If the admin later updates the English source again, the affected translations are flagged for review, and new auto-translations are generated, but the previous manual overrides are preserved until the admin explicitly updates or resets them.

---

## 7. Edge Cases & Constraints

- **Services with no fields**: a service can be published without any calculator fields. In that case, the service page shows the description and contact details but no calculator or quote buttons.
- **Empty sections**: if there are no published projects, the Projects page shows a friendly empty-state message. The same applies to the Careers page.
- **Admin deletes a service referenced by projects**: projects retain their associated service category label even if the service is later deleted, so that historical data is not lost. However, that category no longer appears as a filter option on the Projects page unless it still has active projects.
- **PDF email delivery failure**: if the email with the PDF cannot be sent (e.g., the visitor entered an invalid email address), the visitor sees a clear error and is offered the option to download the PDF instead.
- **Formula produces a zero or negative result**: if the calculator formula results in a zero or negative total (e.g., due to an admin configuration error), the quote displays "Contact us for a price" rather than showing a negative or zero amount, and both the download and email actions remain available with the appropriate caveat.
- **Home page service count** (✅ built 2026-09-07): the admin controls how many service cards are shown on the Home page. If the admin sets the count higher than the number of published services, all published services are shown and no empty placeholders appear.
- **Session timeout**: the admin session expires after a period of inactivity. The admin is redirected to the login screen, and any unsaved changes in an editor are lost (the editor should warn the admin before the session expires if possible).
