/**
 * HTML email templates. All interpolated values are escaped.
 */
import { formatIST } from "./time.js";

const escapeHtml = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** Shared outer layout so every mail looks consistent. */
function layout(title, bodyHtml) {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;color:#111">
    <div style="max-width:560px;margin:0 auto;background:#fff;border:3px solid #111;border-radius:12px;overflow:hidden">
      <div style="background:#00629b;color:#fff;padding:16px 24px;font-size:18px;font-weight:bold">
        IEEE-VIT Enrollments
      </div>
      <div style="padding:24px">
        <h2 style="margin:0 0 16px;font-size:20px">${escapeHtml(title)}</h2>
        ${bodyHtml}
        <p style="margin:24px 0 0;color:#555;font-size:13px">Regards,<br/>Team IEEE-VIT</p>
      </div>
    </div>
  </body>
</html>`;
}

const button = (href, label) =>
  `<a href="${escapeHtml(href)}" style="display:inline-block;background:#24b577;color:#111;border:2px solid #111;border-radius:8px;padding:10px 18px;font-weight:bold;text-decoration:none">${escapeHtml(label)}</a>`;

/** Sent when a task is assigned - the 48h countdown starts now. */
export function taskAssignedEmail({ name, taskTitle, domain, deadline, appUrl }) {
  return {
    subject: "Your IEEE-VIT enrollment task is ready",
    html: layout(
      "Your task has been assigned",
      `<p>Hi ${escapeHtml(name)},</p>
       <p>Thanks for applying! Based on your first-choice domain
       (<b>${escapeHtml(domain)}</b>) you have been assigned the task
       <b>${escapeHtml(taskTitle)}</b>.</p>
       <p>Submit it before <b>${escapeHtml(formatIST(deadline))} IST</b>.
       Late submissions are not accepted.</p>
       ${appUrl ? `<p>${button(`${appUrl}/task`, "View task")}</p>` : ""}`
    ),
  };
}

/** Sent right after a candidate books an interview slot. */
export function slotBookedEmail({ name, startTime, leadMinutes, appUrl }) {
  return {
    subject: "Interview slot confirmed - IEEE-VIT",
    html: layout(
      "Your slot is booked",
      `<p>Hi ${escapeHtml(name)},</p>
       <p>Your interview slot is confirmed for
       <b>${escapeHtml(formatIST(startTime))} IST</b>.</p>
       <p>We will email you the meeting link about ${escapeHtml(leadMinutes)}
       minutes before your slot. It will also appear on the enrollments website.</p>
       ${appUrl ? `<p>${button(`${appUrl}/interview`, "View booking")}</p>` : ""}`
    ),
  };
}

/** Sent ~30 minutes before the slot by the meeting-link dispatcher. */
export function meetingLinkEmail({ name, startTime, meetLink }) {
  return {
    subject: "Your IEEE-VIT interview link",
    html: layout(
      "Your interview starts soon",
      `<p>Hi ${escapeHtml(name)},</p>
       <p>Your interview is scheduled for
       <b>${escapeHtml(formatIST(startTime))} IST</b>.
       Please join on time using the link below.</p>
       <p>${button(meetLink, "Join meeting")}</p>
       <p style="font-size:13px;color:#555">Or paste this link in your browser:<br/>
       ${escapeHtml(meetLink)}</p>
       <p>All the best!</p>`
    ),
  };
}

/** Sent to every candidate when an admin posts a new announcement. */
export function announcementEmail({ name, message, appUrl }) {
  return {
    subject: "New update from IEEE-VIT Enrollments",
    html: layout(
      "New announcement",
      `<p>Hi ${escapeHtml(name)},</p>
       <p style="white-space:pre-line">${escapeHtml(message)}</p>
       ${appUrl ? `<p>${button(appUrl, "Open enrollments")}</p>` : ""}`
    ),
  };
}
