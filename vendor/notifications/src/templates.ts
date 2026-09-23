import type { EmailMessage } from './IEmailProvider'

export interface RenderedEmailBody {
  html: string
  text: string
}

const BRAND_COLOR = '#0D7FB6'

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] as string,
  )
}

function wrap(title: string, bodyHtml: string, ctaUrl?: string, ctaLabel?: string): string {
  const cta =
    ctaUrl && ctaLabel
      ? `<p style="margin:32px 0 0"><a href="${escapeHtml(ctaUrl)}" style="background:${BRAND_COLOR};color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;display:inline-block">${escapeHtml(ctaLabel)}</a></p>`
      : ''
  return `<!doctype html>
<html>
  <body style="margin:0;padding:32px 16px;background:#f4f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#12212f">
    <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;border:1px solid #e2e8f0">
      <h1 style="margin:0 0 20px;font-size:20px;color:${BRAND_COLOR}">${escapeHtml(title)}</h1>
      ${bodyHtml}
      ${cta}
      <p style="margin:32px 0 0;font-size:12px;color:#64748b">sPark &mdash; sparkparking.gr</p>
    </div>
  </body>
</html>`
}

export function renderEmailBody(message: EmailMessage): RenderedEmailBody {
  switch (message.template) {
    case 'operator-invite': {
      const data = message.data as { acceptUrl: string }
      const html = wrap(
        `You're invited to sPark`,
        `<p>Hello,</p><p>You've been invited to join sPark as a parking operator. Click below to set your password, name your business and get started.</p>`,
        data.acceptUrl,
        'Set up your account',
      )
      const text = `You're invited to sPark as a parking operator. Set your password: ${data.acceptUrl}`
      return { html, text }
    }
    case 'operator-member-invite': {
      const data = message.data as { businessName: string; acceptUrl: string; isAdmin: boolean }
      const position = data.isAdmin ? 'an administrator' : 'a staff member'
      const html = wrap(
        `Join ${data.businessName} on sPark`,
        `<p>Hello,</p><p>You have been invited to join <strong>${escapeHtml(data.businessName)}</strong> on sPark as ${position}. Click below to set your password and get started.</p>`,
        data.acceptUrl,
        'Set up your account',
      )
      const text = `You have been invited to join ${data.businessName} on sPark as ${position}. Set your password: ${data.acceptUrl}`
      return { html, text }
    }
    case 'platform-admin-invite': {
      const data = message.data as { acceptUrl: string; invitedByName: string }
      const html = wrap(
        'You have been invited to administer sPark',
        `<p>Hello,</p><p><strong>${escapeHtml(data.invitedByName)}</strong> has invited you to join the sPark platform administration team. Click below to set your password and sign in.</p><p style="font-size:13px;color:#64748b">If you were not expecting this, ignore this email — the link expires on its own and grants nothing until it is used.</p>`,
        data.acceptUrl,
        'Set up your account',
      )
      const text = `${data.invitedByName} has invited you to administer sPark. Set your password: ${data.acceptUrl}`
      return { html, text }
    }
    // The one template addressed to sPark rather than to a customer: an operator asked to
    // change plan and a human has to action it by hand. Everything the recipient needs to
    // answer without opening a second system is in the body, and the CTA lands on the
    // operator's admin page where the plan is actually assigned.
    case 'operator-upgrade-requested': {
      const data = message.data as {
        operatorName: string
        requesterName: string
        requesterEmail: string
        requestedPlanName: string | null
        message: string | null
        operatorUrl: string
      }
      const plan = data.requestedPlanName
        ? `<p><strong>Requested plan:</strong> ${escapeHtml(data.requestedPlanName)}</p>`
        : `<p><strong>Requested plan:</strong> not specified — they asked to be contacted.</p>`
      const note = data.message
        ? `<p style="margin:20px 0;padding:16px;background:#f4f6f8;border-radius:8px">${escapeHtml(data.message)}</p>`
        : ''
      const html = wrap(
        'Upgrade requested',
        `<p><strong>${escapeHtml(data.operatorName)}</strong> has requested a subscription upgrade.</p>
         <p><strong>Requested by:</strong> ${escapeHtml(data.requesterName)} (${escapeHtml(data.requesterEmail)})</p>
         ${plan}
         ${note}`,
        data.operatorUrl,
        'Open the operator',
      )
      const text = [
        `${data.operatorName} has requested a subscription upgrade.`,
        `Requested by: ${data.requesterName} (${data.requesterEmail})`,
        `Requested plan: ${data.requestedPlanName ?? 'not specified'}`,
        ...(data.message ? [`Message: ${data.message}`] : []),
        data.operatorUrl,
      ].join('\n')
      return { html, text }
    }
    // The only operator email that follows a SUCCESS. It has to read as a heads-up rather
    // than as a refusal, so it states the numbers plainly and links to the page where the
    // customer can act on them — the same self-serve billing page the upgrade request is
    // filed from.
    case 'operator-quota-threshold': {
      const data = message.data as {
        businessName: string
        resourceLabel: string
        current: number
        limit: number
        threshold: 80 | 100
        billingUrl: string
      }
      const atLimit = data.threshold === 100
      const headline = atLimit
        ? `You have used all of your ${data.resourceLabel}`
        : `You are close to your ${data.resourceLabel} limit`
      const consequence = atLimit
        ? `<p>Your next ${escapeHtml(data.resourceLabel)} will be refused until you move onto a larger plan or free a slot.</p>`
        : `<p>Nothing is blocked yet — this is a heads-up so the limit does not surprise you mid-setup.</p>`
      const html = wrap(
        headline,
        `<p><strong>${escapeHtml(data.businessName)}</strong> is using
         <strong>${data.current} of ${data.limit}</strong> ${escapeHtml(data.resourceLabel)}
         on its current plan.</p>
         ${consequence}`,
        data.billingUrl,
        'See your plan',
      )
      const text = [
        `${headline}.`,
        `${data.businessName} is using ${data.current} of ${data.limit} ${data.resourceLabel} on its current plan.`,
        atLimit
          ? `Your next ${data.resourceLabel} will be refused until you move onto a larger plan or free a slot.`
          : 'Nothing is blocked yet — this is a heads-up so the limit does not surprise you mid-setup.',
        data.billingUrl,
      ].join('\n')
      return { html, text }
    }
    case 'password-reset': {
      const data = message.data as { resetLink: string }
      const html = wrap(
        'Reset your sPark password',
        `<p>We received a request to reset your password. If this wasn't you, you can ignore this email.</p>`,
        data.resetLink,
        'Reset password',
      )
      const text = `Reset your sPark password: ${data.resetLink}`
      return { html, text }
    }
    // Its own template rather than a reuse of password-reset, because the recipient's
    // situation is the opposite one. Somebody resetting has lost access and expects a
    // link; somebody changing is signed in and already typed their current password, so
    // the mail has to name that step — otherwise an unexpected copy reads as the
    // account-takeover warning it is not, and an expected one buries the warning it is.
    case 'password-change': {
      const data = message.data as { resetLink: string }
      const html = wrap(
        'Confirm your sPark password change',
        `<p>You asked to change your sPark password from your profile page and confirmed your current one. Use the link below to set the new password — until you do, nothing has changed.</p>
         <p>If this wasn't you, someone knows your current password: ignore this email, then sign in and change it yourself straight away.</p>`,
        data.resetLink,
        'Confirm password change',
      )
      const text = [
        'You asked to change your sPark password from your profile page and confirmed your current one.',
        `Set the new password: ${data.resetLink}`,
        "If this wasn't you, someone knows your current password — ignore this email, then sign in and change it yourself straight away.",
      ].join('\n')
      return { html, text }
    }
    case 'booking-confirmation': {
      const data = message.data as {
        facilityName: string
        accessCode: string
        startsAt: string | Date
        endsAt: string | Date
        amountCents: number
        currency: string
      }
      const amount = (data.amountCents / 100).toFixed(2)
      const html = wrap(
        'Booking confirmed',
        `<p>Your parking spot at <strong>${escapeHtml(data.facilityName)}</strong> is confirmed.</p>
         <p style="margin:20px 0;padding:16px;background:#f4f6f8;border-radius:8px">
           <strong>Access code:</strong> ${escapeHtml(data.accessCode)}<br/>
           <strong>From:</strong> ${new Date(data.startsAt).toLocaleString('en-GB')}<br/>
           <strong>Until:</strong> ${new Date(data.endsAt).toLocaleString('en-GB')}<br/>
           <strong>Total:</strong> ${amount} ${escapeHtml(data.currency)}
         </p>`,
      )
      const text = `Booking confirmed at ${data.facilityName}. Access code: ${data.accessCode}. ${new Date(data.startsAt).toLocaleString('en-GB')} - ${new Date(data.endsAt).toLocaleString('en-GB')}. Total: ${amount} ${data.currency}.`
      return { html, text }
    }
    case 'booking-cancellation': {
      const data = message.data as { facilityName: string; accessCode: string }
      const html = wrap(
        'Booking cancelled',
        `<p>Your booking at <strong>${escapeHtml(data.facilityName)}</strong> (access code ${escapeHtml(data.accessCode)}) has been cancelled.</p>`,
      )
      const text = `Your booking at ${data.facilityName} (access code ${data.accessCode}) has been cancelled.`
      return { html, text }
    }
    // The only unsolicited template in the set: it is not a receipt and not a response to
    // anything the rider did, so it leads with the number that justifies its own existence
    // and carries no call to action beyond naming the plan that produced it.
    case 'driver-savings-summary': {
      const data = message.data as {
        riderName: string | null
        savedFormatted: string
        planName: string | null
        periodStart: string | Date
        periodEnd: string | Date
      }
      const greeting = data.riderName ? `Hello ${escapeHtml(data.riderName)},` : 'Hello,'
      const period = `${new Date(data.periodStart).toLocaleDateString('en-GB')} – ${new Date(data.periodEnd).toLocaleDateString('en-GB')}`
      // Named only when they still hold one. A rider whose subscription lapsed inside the
      // period genuinely saved the money and is told so, without being told they are still
      // subscribed.
      const plan = data.planName
        ? `<p style="margin:20px 0 0">Your <strong>${escapeHtml(data.planName)}</strong> plan is what earned it.</p>`
        : ''
      const html = wrap(
        'Your sPark savings',
        `<p>${greeting}</p>
         <p>Over the last 30 days your plan discount saved you</p>
         <p style="margin:20px 0;padding:16px;background:#f4f6f8;border-radius:8px;font-size:28px;font-weight:700;text-align:center">${escapeHtml(data.savedFormatted)}</p>
         ${plan}
         <p style="margin:24px 0 0;font-size:13px;color:#64748b">Bookings between ${escapeHtml(period)}. Cancelled and refunded bookings are not counted.</p>`,
      )
      const text = [
        data.riderName ? `Hello ${data.riderName},` : 'Hello,',
        `Over the last 30 days your plan discount saved you ${data.savedFormatted}.`,
        ...(data.planName ? [`Your ${data.planName} plan is what earned it.`] : []),
        `Bookings between ${period}. Cancelled and refunded bookings are not counted.`,
      ].join('\n')
      return { html, text }
    }
  }
}
