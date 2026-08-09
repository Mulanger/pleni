# Processors, subprocessors and transfers

Working register, 2026-08-09. Public provider pages are evidence of available
terms, not evidence that the project account has executed every required DPA or
selected the stated region. Account-side verification remains mandatory.

| Provider | Role and data | Published mechanism | Project evidence still required |
|---|---|---|---|
| Clerk | Authentication processor for end-user account data; separate roles may apply to Clerk's own account/service data. Processes ids, email/profile fields, sessions, device/request and security events. | [DPA](https://clerk.com/legal/dpa) describes DPF and SCC modules; [subprocessors](https://clerk.com/legal/subprocessors); [privacy](https://clerk.com/legal/privacy). | Confirm DPA acceptance, production data location/config, session lifetime, deletion behavior, logs and subprocessor-change contact. |
| Supabase | Database/API processor for public metadata, private comment identifiers, bodies, reports and moderation. | [DPA](https://supabase.com/legal/dpa) and Supabase legal/subprocessor materials. | Confirm project region, DPA, backups/PITR, logs, support access, deletion/restore windows and subprocessor list. |
| bunny.net | Storage/CDN processor for video and portraits; edge receives media request data. | [GDPR page](https://bunny.net/gdpr/) says visitor logs may include anonymised IP, URL, country and user agent; [subprocessors](https://bunny.net/gdpr/sub-processors/). | Execute/confirm DPA in dashboard, log/anonymisation settings, retention, storage/edge regions and support access. |
| InstaPods | Static web host; receives application asset requests and may keep access/security logs. | Provider contract/account materials. | Obtain current DPA/privacy terms, legal entity, region, log fields/retention, subprocessors and deletion process. |
| Sveriges riksdag | Independent public source/controller when a viewer follows a source link; source of politician and parliamentary public data. | [riksdagen.se](https://www.riksdagen.se/). | Keep source attribution and link to original; document corrections/takedowns. |

## Transfer rule

No provider may be described as “EU-only” from marketing copy or an edge
location alone. Record the contracted entity, processing/storage region,
support access, subprocessors, adequacy decision or SCC module, supplementary
measures and date checked. Recheck at least annually and after provider notice.

## Deployment gate

Account/comment processing is already live, so the four provider-account checks
above are operational debt, not a theoretical future task. Server-side watch
history, exposures or inferred political profiles may not launch until this
register contains account-specific evidence rather than public links alone.
