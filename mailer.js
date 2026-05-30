'use strict';

const nodemailer = require('nodemailer');

const transport = nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
    },
});

const FROM = process.env.SMTP_FROM || 'ClanBot <noreply@clanbot.gg>';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || '';

async function sendProvisionedEmail({ to, name, setupUrl, orderId }) {
    await transport.sendMail({
        from: FROM,
        to,
        subject: '🎮 Your ClanBot is ready!',
        html: `
<!DOCTYPE html>
<html>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0d0f1a;color:#f1f5f9;margin:0;padding:40px 20px;">
  <div style="max-width:540px;margin:0 auto;background:#16213e;border:1px solid #1e2d50;border-radius:16px;padding:40px;">
    <div style="text-align:center;margin-bottom:32px;">
      <div style="font-size:24px;font-weight:900;color:#f1f5f9;">Clan<span style="color:#3b82f6;">Bot</span></div>
    </div>
    <h1 style="font-size:22px;font-weight:800;color:#f1f5f9;margin:0 0 12px;">Your bot is live, ${name || 'Commander'}!</h1>
    <p style="color:#94a3b8;line-height:1.7;margin:0 0 28px;">
      Your ClanBot instance has been provisioned and is starting up. Click the button below to run the setup wizard — it takes under 5 minutes to connect your Discord server and Rust+ account.
    </p>
    <div style="text-align:center;margin-bottom:32px;">
      <a href="${setupUrl}/setup" style="display:inline-block;background:#3b82f6;color:#fff;border-radius:12px;padding:16px 36px;font-size:16px;font-weight:700;text-decoration:none;">
        Open Setup Wizard →
      </a>
    </div>
    <div style="background:#0d0f1a;border:1px solid #1e2d50;border-radius:10px;padding:16px;font-size:13px;color:#64748b;">
      <strong style="color:#94a3b8;">Your setup URL:</strong><br>
      <code style="color:#60a5fa;">${setupUrl}/setup</code><br><br>
      <strong style="color:#94a3b8;">Order ID:</strong> #${orderId}
    </div>
    <p style="color:#475569;font-size:12px;margin:24px 0 0;text-align:center;">
      Questions? Reply to this email. &copy; 2026 ClanBot
    </p>
  </div>
</body>
</html>`,
    });
}

async function sendFailureEmail({ to, name, orderId, error }) {
    await transport.sendMail({
        from: FROM,
        to,
        subject: 'ClanBot — provisioning issue (we\'re on it)',
        html: `
<!DOCTYPE html>
<html>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0d0f1a;color:#f1f5f9;margin:0;padding:40px 20px;">
  <div style="max-width:540px;margin:0 auto;background:#16213e;border:1px solid #1e2d50;border-radius:16px;padding:40px;">
    <h1 style="font-size:22px;font-weight:800;color:#f1f5f9;margin:0 0 12px;">Hi ${name || 'there'},</h1>
    <p style="color:#94a3b8;line-height:1.7;margin:0 0 16px;">
      We received your order (#${orderId}) but hit a snag provisioning your bot automatically. Our team has been notified and will set it up manually within a few hours.
    </p>
    <p style="color:#94a3b8;line-height:1.7;margin:0;">
      You won't be charged extra and won't experience any delay in service. We'll email you again once it's ready.
    </p>
    <p style="color:#475569;font-size:12px;margin:32px 0 0;text-align:center;">
      &copy; 2026 ClanBot
    </p>
  </div>
</body>
</html>`,
    });
}

async function sendAdminNewOrderEmail({ orderId, customerEmail, steamId }) {
    if (!ADMIN_EMAIL) return; /* No admin recipient configured — panel still shows the order. */
    await transport.sendMail({
        from: FROM,
        to: ADMIN_EMAIL,
        subject: `🟠 ClanBot order #${orderId} awaiting approval`,
        html: `
<!DOCTYPE html>
<html>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0d0f1a;color:#f1f5f9;margin:0;padding:40px 20px;">
  <div style="max-width:540px;margin:0 auto;background:#16213e;border:1px solid #1e2d50;border-radius:16px;padding:40px;">
    <h1 style="font-size:20px;font-weight:800;color:#f1f5f9;margin:0 0 12px;">New paid order awaiting approval</h1>
    <p style="color:#94a3b8;line-height:1.7;margin:0 0 16px;">
      Order <strong style="color:#f1f5f9;">#${orderId}</strong> has paid and is waiting for you to provision it.
    </p>
    <div style="background:#0d0f1a;border:1px solid #1e2d50;border-radius:10px;padding:16px;font-size:13px;color:#94a3b8;">
      <strong style="color:#94a3b8;">Email:</strong> ${customerEmail || '—'}<br>
      <strong style="color:#94a3b8;">Steam ID:</strong> <code style="color:#60a5fa;">${steamId || '—'}</code>
    </div>
    <p style="color:#94a3b8;line-height:1.7;margin:20px 0 0;">
      Open the admin panel and click <strong style="color:#f1f5f9;">Provision</strong> to spin up the bot.
    </p>
  </div>
</body>
</html>`,
    });
}

async function sendSuspendedEmail({ to, name, orderId }) {
    await transport.sendMail({
        from: FROM,
        to,
        subject: 'ClanBot — your bot has been paused',
        html: `
<!DOCTYPE html>
<html>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0d0f1a;color:#f1f5f9;margin:0;padding:40px 20px;">
  <div style="max-width:540px;margin:0 auto;background:#16213e;border:1px solid #1e2d50;border-radius:16px;padding:40px;">
    <h1 style="font-size:22px;font-weight:800;color:#f1f5f9;margin:0 0 12px;">Hi ${name || 'there'},</h1>
    <p style="color:#94a3b8;line-height:1.7;margin:0 0 16px;">
      Your ClanBot subscription (order #${orderId}) is no longer active, so we've paused your bot. Your configuration is safe — nothing has been deleted.
    </p>
    <p style="color:#94a3b8;line-height:1.7;margin:0;">
      Re-subscribe any time and your bot resumes right where it left off. Reply to this email if you need a hand.
    </p>
    <p style="color:#475569;font-size:12px;margin:32px 0 0;text-align:center;">&copy; 2026 ClanBot</p>
  </div>
</body>
</html>`,
    });
}

module.exports = { sendProvisionedEmail, sendFailureEmail, sendAdminNewOrderEmail, sendSuspendedEmail };
