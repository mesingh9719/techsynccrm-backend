/**
 * Transactional email templates. Each returns { subject, html, text }.
 * HTML uses inline styles and tables only, for compatibility with email clients.
 */

const escape = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

/** `cta` is optional: { label, url, showLink? } — showLink: false hides the copy-this-link fallback. */
function layout({ preheader, heading, body, cta, footnote }) {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(heading)}</title></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#18181b;">
  <span style="display:none!important;opacity:0;color:transparent;height:0;width:0;overflow:hidden;">${escape(preheader)}</span>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:16px;border:1px solid #e4e4e7;">
        <tr><td style="padding:32px 32px 0;">
          <table role="presentation" cellpadding="0" cellspacing="0"><tr>
            <td style="width:28px;height:28px;background:#18181b;border-radius:7px;color:#ffffff;font-weight:700;font-size:15px;text-align:center;line-height:28px;">T</td>
            <td style="padding-left:8px;font-size:16px;font-weight:600;color:#09090b;">TechSync <span style="font-weight:400;color:#71717a;">CRM</span></td>
          </tr></table>
        </td></tr>
        <tr><td style="padding:28px 32px 8px;">
          <h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;color:#09090b;">${escape(heading)}</h1>
          ${body}
        </td></tr>
        ${
          cta
            ? `<tr><td style="padding:16px 32px 8px;">
          <a href="${escape(cta.url)}" style="display:inline-block;background:#3349df;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 20px;border-radius:10px;">${escape(cta.label)}</a>
        </td></tr>`
            : ''
        }
        <tr><td style="padding:16px 32px 32px;font-size:13px;line-height:1.6;color:#71717a;">
          ${footnote}${
            cta?.showLink === false || !cta
              ? ''
              : `<br><br>
          If the button doesn’t work, copy this link into your browser:<br>
          <a href="${escape(cta.url)}" style="color:#3349df;word-break:break-all;">${escape(cta.url)}</a>`
          }
        </td></tr>
      </table>
      <p style="margin:16px 0 0;font-size:12px;color:#a1a1aa;">TechSync Technologies Pvt. Ltd. · Bengaluru, India</p>
    </td></tr>
  </table>
</body>
</html>`
}

const para = (text) => `<p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#3f3f46;">${text}</p>`

export function verificationEmail({ name, url, hours }) {
  const first = name.split(' ')[0]
  return {
    subject: 'Verify your email for TechSync CRM',
    html: layout({
      preheader: 'Confirm your email to finish setting up your workspace.',
      heading: 'Confirm your email address',
      body: para(`Hi ${escape(first)}, thanks for signing up for TechSync CRM. Please confirm this is your email address to finish setting up your workspace.`),
      cta: { label: 'Verify email address', url },
      footnote: `This link expires in ${hours} hours. If you didn’t create a TechSync account, you can ignore this email.`,
    }),
    text: `Hi ${first},\n\nThanks for signing up for TechSync CRM. Confirm your email address to finish setting up your workspace:\n\n${url}\n\nThis link expires in ${hours} hours. If you didn't create a TechSync account, you can ignore this email.\n\n— TechSync CRM`,
  }
}

export function passwordResetEmail({ name, url, minutes }) {
  const first = name.split(' ')[0]
  return {
    subject: 'Reset your TechSync CRM password',
    html: layout({
      preheader: 'Use this link to choose a new password.',
      heading: 'Reset your password',
      body: para(`Hi ${escape(first)}, we received a request to reset the password for your TechSync account. Click the button below to choose a new one.`),
      cta: { label: 'Choose a new password', url },
      footnote: `This link expires in ${minutes} minutes and can only be used once. If you didn’t request a reset, you can safely ignore this email — your password won’t change.`,
    }),
    text: `Hi ${first},\n\nWe received a request to reset your TechSync CRM password. Choose a new one here:\n\n${url}\n\nThis link expires in ${minutes} minutes and can only be used once. If you didn't request this, ignore this email.\n\n— TechSync CRM`,
  }
}

export function welcomeEmail({ name, url }) {
  const first = name.split(' ')[0]
  return {
    subject: 'Welcome to TechSync CRM',
    html: layout({
      preheader: 'Your workspace is ready. Here’s where to start.',
      heading: `Welcome aboard, ${first}`,
      body:
        para('Your workspace is ready. Most teams get value fastest by doing these three things first:') +
        `<ol style="margin:0 0 12px;padding-left:20px;font-size:15px;line-height:1.8;color:#3f3f46;">
          <li>Import your leads from Excel</li><li>Connect your WhatsApp number</li><li>Invite your team</li></ol>`,
      cta: { label: 'Open your workspace', url },
      footnote: 'Questions? Just reply to this email — a real person on our team will help.',
    }),
    text: `Welcome aboard, ${first}!\n\nYour workspace is ready. Start here:\n1. Import your leads from Excel\n2. Connect your WhatsApp number\n3. Invite your team\n\nOpen your workspace: ${url}\n\nQuestions? Just reply to this email.\n\n— TechSync CRM`,
  }
}

// ---------- Marketing forms (M01) ----------

/** Label/value rows for internal notification emails. Values are escaped; newlines preserved. */
function detailsTable(rows) {
  const cells = rows
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(
      ([label, value]) => `<tr>
        <td style="padding:6px 12px 6px 0;font-size:13px;color:#71717a;vertical-align:top;white-space:nowrap;">${escape(label)}</td>
        <td style="padding:6px 0;font-size:14px;color:#18181b;white-space:pre-wrap;">${escape(value)}</td>
      </tr>`,
    )
    .join('')
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 12px;">${cells}</table>`
}

const detailsText = (rows) =>
  rows
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([label, value]) => `${label}: ${value}`)
    .join('\n')

export function contactConfirmationEmail({ name, ticketNo, topicLabel, helpUrl }) {
  const first = name.split(' ')[0]
  return {
    subject: `We've received your message [${ticketNo}]`,
    html: layout({
      preheader: `Reference ${ticketNo} — we'll reply within one business day.`,
      heading: 'Thanks for getting in touch',
      body:
        para(`Hi ${escape(first)}, we've received your message about <strong>${escape(topicLabel.toLowerCase())}</strong> and someone from our team will reply within one business day.`) +
        para(`Your reference is <strong style="font-family:monospace;">${escape(ticketNo)}</strong>. Just reply to this email if you'd like to add anything.`),
      cta: { label: 'Browse the Help Center', url: helpUrl, showLink: false },
      footnote: 'You received this email because you contacted TechSync CRM through our website.',
    }),
    text: `Hi ${first},\n\nThanks for getting in touch. We've received your message about ${topicLabel.toLowerCase()} and will reply within one business day.\n\nYour reference: ${ticketNo}\n\nLooking for a quick answer? ${helpUrl}\n\n— TechSync CRM`,
  }
}

export function contactInternalEmail({ ticketNo, topicLabel, name, email, company, phone, message, meta }) {
  const rows = [
    ['Reference', ticketNo],
    ['Topic', topicLabel],
    ['Name', name],
    ['Email', email],
    ['Company', company],
    ['Phone', phone],
    ['Message', message],
    ['Page', meta.pageUrl],
    ['UTM', meta.utm && Object.entries(meta.utm).map(([k, v]) => `${k}=${v}`).join(', ')],
  ]
  return {
    subject: `[${topicLabel}] ${name}${company ? ` (${company})` : ''} — ${ticketNo}`,
    replyTo: email,
    html: layout({
      preheader: message.slice(0, 120),
      heading: `New contact request: ${topicLabel}`,
      body: detailsTable(rows),
      cta: null,
      footnote: 'Reply to this email to answer the customer directly.',
    }),
    text: `New contact request\n\n${detailsText(rows)}`,
  }
}

export function demoConfirmationEmail({ firstName, company, whenLabel, confirmationId, featuresUrl }) {
  return {
    subject: `Your TechSync demo is booked — ${whenLabel}`,
    html: layout({
      preheader: `${whenLabel} IST · confirmation ${confirmationId}`,
      heading: `You're booked, ${firstName}`,
      body:
        para(`Thanks for booking a demo for ${escape(company)}. A product specialist will walk you through TechSync set up the way you sell.`) +
        detailsTable([
          ['When', `${whenLabel} IST (30 minutes)`],
          ['Confirmation', confirmationId],
        ]) +
        para("We'll email you the video link before the call. The attached invite adds it to your calendar."),
      cta: { label: 'Explore features meanwhile', url: featuresUrl, showLink: false },
      footnote: 'Need to reschedule? Just reply to this email.',
    }),
    text: `Hi ${firstName},\n\nYour TechSync CRM demo is booked.\n\nWhen: ${whenLabel} IST (30 minutes)\nConfirmation: ${confirmationId}\n\nWe'll email you the video link before the call. Need to reschedule? Reply to this email.\n\n— TechSync CRM`,
  }
}

export function demoInternalEmail({ confirmationId, whenLabel, firstName, lastName, email, phone, company, companySize, role, interests, notes, meta }) {
  const rows = [
    ['When', `${whenLabel} IST`],
    ['Confirmation', confirmationId],
    ['Name', `${firstName} ${lastName}`],
    ['Email', email],
    ['Phone', phone],
    ['Company', `${company} (${companySize} employees)`],
    ['Role', role],
    ['Interested in', interests.join(', ')],
    ['Notes', notes],
    ['Page', meta.pageUrl],
    ['UTM', meta.utm && Object.entries(meta.utm).map(([k, v]) => `${k}=${v}`).join(', ')],
  ]
  return {
    subject: `[Demo] ${company} — ${whenLabel} IST`,
    replyTo: email,
    html: layout({
      preheader: `${firstName} ${lastName}, ${role} at ${company}`,
      heading: 'New demo booking',
      body: detailsTable(rows),
      cta: null,
      footnote: 'Reply to this email to contact the prospect directly.',
    }),
    text: `New demo booking\n\n${detailsText(rows)}`,
  }
}

export function newsletterConfirmEmail({ url, days }) {
  return {
    subject: 'Confirm your TechSync newsletter subscription',
    html: layout({
      preheader: 'One click to start receiving our newsletter.',
      heading: 'Confirm your subscription',
      body: para('Thanks for subscribing to the TechSync newsletter — practical sales and CRM advice for growing Indian businesses, about twice a month. Please confirm this is your email address.'),
      cta: { label: 'Confirm subscription', url },
      footnote: `This link expires in ${days} days. If you didn't sign up, ignore this email and you won't hear from us.`,
    }),
    text: `Thanks for subscribing to the TechSync newsletter.\n\nConfirm your subscription:\n${url}\n\nThis link expires in ${days} days. If you didn't sign up, ignore this email.\n\n— TechSync CRM`,
  }
}

// ---------- Team (M04) ----------

export function invitationEmail({ inviterName, organizationName, roleLabel, url, days }) {
  return {
    subject: `${inviterName} invited you to ${organizationName} on TechSync CRM`,
    html: layout({
      preheader: `Join ${organizationName} as ${roleLabel}.`,
      heading: `Join ${organizationName} on TechSync`,
      body: para(
        `${escape(inviterName)} has invited you to join <strong>${escape(organizationName)}</strong> as <strong>${escape(roleLabel)}</strong>. TechSync is where the team keeps its leads, deals and follow-ups.`,
      ),
      cta: { label: 'Accept invitation', url },
      footnote: `This invitation expires in ${days} days. If you weren’t expecting it, you can ignore this email.`,
    }),
    text: `${inviterName} invited you to join ${organizationName} on TechSync CRM as ${roleLabel}.\n\nAccept the invitation:\n${url}\n\nThis invitation expires in ${days} days. If you weren't expecting it, ignore this email.\n\n— TechSync CRM`,
  }
}

export function removedFromWorkspaceEmail({ name, organizationName }) {
  const first = name.split(' ')[0]
  return {
    subject: `Your access to ${organizationName} has been removed`,
    html: layout({
      preheader: `You can no longer sign in to ${organizationName}.`,
      heading: 'Workspace access removed',
      body: para(
        `Hi ${escape(first)}, an admin of <strong>${escape(organizationName)}</strong> has removed your access to that workspace on TechSync CRM. Your account and any other workspaces are unaffected.`,
      ),
      cta: null,
      footnote: 'If you think this is a mistake, please contact the workspace’s admin.',
    }),
    text: `Hi ${first},\n\nAn admin of ${organizationName} has removed your access to that workspace on TechSync CRM. Your account and any other workspaces are unaffected.\n\n— TechSync CRM`,
  }
}

// ---------- Account security (M05) ----------

const securityFootnote = 'If this wasn’t you, reset your password straight away and contact us by replying to this email.'

export function accountLockedEmail({ name, minutes, resetUrl }) {
  const first = name.split(' ')[0]
  return {
    subject: 'Your TechSync account has been temporarily locked',
    html: layout({
      preheader: `Too many failed sign-in attempts. Try again in ${minutes} minutes.`,
      heading: 'Too many sign-in attempts',
      body:
        para(`Hi ${escape(first)}, we noticed several failed attempts to sign in to your TechSync account, so we’ve locked it for ${minutes} minutes to keep it safe.`) +
        para('If you’ve forgotten your password, you can reset it now.'),
      cta: { label: 'Reset your password', url: resetUrl },
      footnote: 'If these attempts weren’t you, someone may be trying to guess your password — resetting it and turning on two-factor authentication will keep your account safe.',
    }),
    text: `Hi ${first},\n\nAfter several failed sign-in attempts we've locked your TechSync account for ${minutes} minutes.\n\nForgotten your password? Reset it here: ${resetUrl}\n\n— TechSync CRM`,
  }
}

export function passwordChangedEmail({ name, when, resetUrl }) {
  const first = name.split(' ')[0]
  return {
    subject: 'Your TechSync password was changed',
    html: layout({
      preheader: 'Your password was just changed.',
      heading: 'Password changed',
      body: para(`Hi ${escape(first)}, the password for your TechSync account was changed on ${escape(when)}. Other devices have been signed out.`),
      cta: { label: 'Wasn’t you? Reset your password', url: resetUrl, showLink: false },
      footnote: securityFootnote,
    }),
    text: `Hi ${first},\n\nThe password for your TechSync account was changed on ${when}. Other devices have been signed out.\n\nIf this wasn't you, reset your password: ${resetUrl}\n\n— TechSync CRM`,
  }
}

export function emailChangeVerifyEmail({ name, newEmail, url, hours }) {
  const first = name.split(' ')[0]
  return {
    subject: 'Confirm your new email address for TechSync CRM',
    html: layout({
      preheader: 'Confirm this address to finish changing your email.',
      heading: 'Confirm your new email',
      body: para(`Hi ${escape(first)}, please confirm that <strong>${escape(newEmail)}</strong> should become the email you use to sign in to TechSync.`),
      cta: { label: 'Confirm new email', url },
      footnote: `This link expires in ${hours} hours. Until you confirm, you keep signing in with your current email.`,
    }),
    text: `Hi ${first},\n\nConfirm ${newEmail} as your new TechSync sign-in email:\n${url}\n\nThis link expires in ${hours} hours.\n\n— TechSync CRM`,
  }
}

export function emailChangeNoticeEmail({ name, newEmail, cancelUrl }) {
  const first = name.split(' ')[0]
  return {
    subject: 'Your TechSync email address is being changed',
    html: layout({
      preheader: `A request was made to change your sign-in email to ${newEmail}.`,
      heading: 'Email change requested',
      body: para(
        `Hi ${escape(first)}, someone signed in to your account asked to change its email to <strong>${escape(newEmail)}</strong>. If that was you, there’s nothing to do here.`,
      ),
      cta: { label: 'This wasn’t me — cancel the change', url: cancelUrl },
      footnote: 'Cancelling also signs out every device, in case someone else has your password.',
    }),
    text: `Hi ${first},\n\nA request was made to change your TechSync sign-in email to ${newEmail}.\n\nIf this wasn't you, cancel the change (this also signs out every device):\n${cancelUrl}\n\n— TechSync CRM`,
  }
}

export function newSignInEmail({ name, device, ip, when, resetUrl }) {
  const first = name.split(' ')[0]
  return {
    subject: 'New sign-in to your TechSync account',
    html: layout({
      preheader: `${device} · ${when}`,
      heading: 'New sign-in detected',
      body:
        para(`Hi ${escape(first)}, your TechSync account was just signed in to from a device or network we haven’t seen recently.`) +
        detailsTable([
          ['Device', device],
          ['IP address', ip],
          ['When', when],
        ]),
      cta: { label: 'Wasn’t you? Reset your password', url: resetUrl, showLink: false },
      footnote: securityFootnote,
    }),
    text: `Hi ${first},\n\nNew sign-in to your TechSync account:\nDevice: ${device}\nIP: ${ip}\nWhen: ${when}\n\nIf this wasn't you, reset your password: ${resetUrl}\n\n— TechSync CRM`,
  }
}

export function twoFactorChangedEmail({ name, enabled, when, securityUrl }) {
  const first = name.split(' ')[0]
  const what = enabled ? 'turned on' : 'turned off'
  const tip = enabled ? ' Keep your recovery codes somewhere safe — they’re the only way in if you lose your phone.' : ''
  return {
    subject: `Two-factor authentication ${what}`,
    html: layout({
      preheader: `Two-factor authentication was ${what} for your account.`,
      heading: `Two-factor authentication ${what}`,
      body: para(`Hi ${escape(first)}, two-factor authentication was ${what} for your TechSync account on ${escape(when)}.${tip}`),
      cta: { label: 'Review security settings', url: securityUrl, showLink: false },
      footnote: securityFootnote,
    }),
    text: `Hi ${first},\n\nTwo-factor authentication was ${what} for your TechSync account on ${when}.\n\nReview your security settings: ${securityUrl}\n\n— TechSync CRM`,
  }
}

// ---------- Plans & trials (M06) ----------

export function trialReminderEmail({ name, organizationName, planName, daysLeft, endsLabel, url }) {
  const first = name.split(' ')[0]
  const when = daysLeft === 0 ? 'today' : daysLeft === 1 ? 'tomorrow' : `in ${daysLeft} days`
  return {
    subject: daysLeft === 0 ? `Your ${planName} trial ends today` : `Your ${planName} trial ends ${when}`,
    html: layout({
      preheader: `${organizationName} moves to the free Starter plan ${when} unless you upgrade.`,
      heading: `Your trial ends ${when}`,
      body:
        para(
          `Hi ${escape(first)}, the ${escape(planName)} trial for <strong>${escape(organizationName)}</strong> ends ${escape(when)} (${escape(endsLabel)}). After that the workspace moves to the free Starter plan: 2 users, 1,000 leads and contacts, and 1 pipeline.`,
        ) + para('Nothing is deleted. Upgrade to keep WhatsApp, automation, quotes and the rest of your team’s access.'),
      cta: { label: 'Upgrade your plan', url, showLink: false },
      footnote: 'Questions about plans or pricing? Just reply to this email.',
    }),
    text: `Hi ${first},\n\nThe ${planName} trial for ${organizationName} ends ${when} (${endsLabel}). After that the workspace moves to the free Starter plan (2 users, 1,000 leads and contacts, 1 pipeline). Nothing is deleted.\n\nUpgrade: ${url}\n\n— TechSync CRM`,
  }
}

export function trialEndedEmail({ name, organizationName, planName, overLimits, url }) {
  const first = name.split(' ')[0]
  const items = overLimits.length
    ? `<ul style="margin:0 0 12px;padding-left:20px;font-size:15px;line-height:1.8;color:#3f3f46;">${overLimits.map((l) => `<li>${escape(l)}</li>`).join('')}</ul>`
    : ''
  return {
    subject: `${organizationName} is now on the Starter plan`,
    html: layout({
      preheader: `Your ${planName} trial has ended. Your data is safe.`,
      heading: 'Your trial has ended',
      body:
        para(`Hi ${escape(first)}, the ${escape(planName)} trial for <strong>${escape(organizationName)}</strong> has ended and the workspace is now on the free Starter plan. Your data is safe — nothing has been deleted.`) +
        (overLimits.length ? para('Your workspace is over some Starter limits:') + items : '') +
        para('Upgrade any time to switch everything back on.'),
      cta: { label: 'See plans', url, showLink: false },
      footnote: 'Questions? Just reply to this email.',
    }),
    text: `Hi ${first},\n\nThe ${planName} trial for ${organizationName} has ended and the workspace is now on the free Starter plan. Nothing has been deleted.${overLimits.length ? `\n\nOver Starter limits:\n${overLimits.map((l) => `- ${l}`).join('\n')}` : ''}\n\nUpgrade any time: ${url}\n\n— TechSync CRM`,
  }
}

/** To the sales inbox when a workspace asks to upgrade (until self-serve billing, M16). */
export function upgradeRequestInternalEmail({ organizationName, organizationId, currentPlan, requestedPlan, name, email, role, message, usage }) {
  const rows = [
    ['Workspace', `${organizationName} (${organizationId})`],
    ['Current plan', currentPlan],
    ['Requested plan', requestedPlan],
    ['Requested by', `${name} <${email}> — ${role}`],
    ['Users', usage.users],
    ['Leads & contacts', usage.records],
    ['Message', message],
  ]
  return {
    subject: `[Upgrade] ${organizationName} → ${requestedPlan}`,
    html: layout({
      preheader: `${name} asked to move ${organizationName} to ${requestedPlan}.`,
      heading: 'Upgrade request',
      body: detailsTable(rows),
      cta: null,
      footnote: 'Reply to this email to reach the requester.',
    }),
    text: `Upgrade request\n\n${detailsText(rows)}\n`,
  }
}

// ---------- Tasks (M10) ----------

export function taskReminderEmail({ name, title, dueLabel, recordLabel, url }) {
  const first = name.split(' ')[0]
  return {
    subject: `Reminder: ${title}`,
    html: layout({
      preheader: `Due ${dueLabel}${recordLabel ? ` · ${recordLabel}` : ''}`,
      heading: title,
      body: para(`Hi ${escape(first)}, this task is due <strong>${escape(dueLabel)}</strong>${recordLabel ? ` — ${escape(recordLabel)}` : ''}.`),
      cta: { label: 'Open task', url, showLink: false },
      footnote: 'You get this because the task is assigned to you. Change or remove the reminder on the task.',
    }),
    text: `Hi ${first},\n\n"${title}" is due ${dueLabel}${recordLabel ? ` — ${recordLabel}` : ''}.\n\nOpen it: ${url}\n\n— TechSync CRM`,
  }
}

/** M11: batching and digests share escaped, recipient-scoped content assembled at send time. */
export function notificationSummaryEmail({ name, organizationName, digest, sections, baseUrl }) {
  const heading = digest ? 'Your daily CRM digest' : 'Updates from your workspace'
  const settingsUrl = `${baseUrl}/app/settings/notifications`
  const itemText = (item) => `${item.title}${item.count > 1 ? ` (${item.count} updates)` : ''}${item.body ? ` — ${item.body}` : ''}`
  const html = sections.map((section) => `<h2 style="font-size:16px;margin:20px 0 8px;">${escape(section.label)}</h2><ul>${section.items.map((item) => `<li style="margin-bottom:10px;"><a href="${escape(`${baseUrl}${item.url || '/app/notifications'}`)}" style="color:#3349df;">${escape(itemText(item))}</a></li>`).join('')}</ul>`).join('')
  return {
    subject: `${heading} · ${organizationName}`,
    html: layout({ preheader: heading, heading, body: para(`Hi ${escape(name.split(' ')[0])}, here’s what’s happening in ${escape(organizationName)}.`) + html, cta: { label: 'Open notifications', url: `${baseUrl}/app/notifications` }, footnote: `Manage email notifications, quiet hours and daily digests in <a href="${escape(settingsUrl)}">notification settings</a>.` }),
    text: `Hi ${name},\n\n${heading} · ${organizationName}\n\n${sections.map((s) => `${s.label}\n${s.items.map((i) => `- ${itemText(i)}\n  ${baseUrl}${i.url || '/app/notifications'}`).join('\n')}`).join('\n\n')}\n\nNotification settings: ${settingsUrl}`,
  }
}
