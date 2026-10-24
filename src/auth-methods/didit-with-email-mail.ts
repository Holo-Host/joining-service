import { CARD, FONT, MONO, escapeHtml } from './didit-with-email-card.js';

const DEFAULT_SUBJECT = 'Verify your identity to join {{network}}';
const DEFAULT_TEMPLATE = `Request to verify your identity to join {{network}} with this email address.

For the device with this agent key:
{{agent_key}}
Continue only if that is the key shown in your app.

To finish, open this link and verify your identity with Didit:
{{link}}

You can open the link on this device or on your phone. It works until {{expires_at}}.

If you did not start this, ignore this email.`;

export interface LinkEmailValues {
  network: string;
  link: string;
  expires_at: string;
  agent_key: string;
}

export interface LinkEmail {
  subject: string;
  text: string;
  html: string;
}

const LINK_LINE = /^\s*\{\{link\}\}\s*$/;
const KEY_LINE = /^\s*\{\{agent_key\}\}\s*$/;
const WRAP = 'overflow-wrap:anywhere;word-break:break-word';
const TEXT_STYLE = `margin:0 0 16px;font-family:${FONT};font-size:15px;line-height:22px;color:${CARD.text};${WRAP}`;
const LEAD_STYLE = `${TEXT_STYLE};font-weight:600;color:${CARD.heading}`;
const CAUTION_STYLE = `${TEXT_STYLE};margin-top:4px;font-size:13px;line-height:20px;color:${CARD.muted}`;

function fill(template: string, values: LinkEmailValues): string {
  return template.replace(/\{\{(network|link|expires_at|agent_key)\}\}/g, (_, key: keyof LinkEmailValues) => values[key]);
}

function button(link: string): string {
  const href = escapeHtml(link);
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td align="center" bgcolor="${CARD.button}" style="border-radius:${CARD.buttonRadius};background-color:${CARD.button}">
<a href="${href}" style="display:block;padding:12px 20px;border-radius:${CARD.buttonRadius};font-family:${FONT};font-size:15px;font-weight:600;line-height:20px;color:${CARD.buttonText};text-decoration:none">Verify your identity</a>
</td></tr></table>
<p style="${TEXT_STYLE};margin-top:12px;font-size:13px;line-height:20px;word-break:break-all"><a href="${href}" style="color:${CARD.text};text-decoration:underline">${href}</a></p>`;
}

function keyBox(agentKey: string): string {
  return `<p style="${TEXT_STYLE};padding:10px 12px;border:1px solid ${CARD.keyBorder};border-radius:${CARD.buttonRadius};background-color:${CARD.keyBox};font-family:${MONO};font-size:13px;line-height:20px;color:${CARD.heading};text-align:left;word-break:break-all;-webkit-user-select:all;user-select:all">${escapeHtml(agentKey)}</p>`;
}

function bodyHtml(template: string, values: LinkEmailValues): string {
  const paragraphs = template.split(/\r?\n[ \t]*\r?\n/).filter((p) => p.trim());
  const out: string[] = [];
  paragraphs.forEach((paragraph, i) => {
    const lines = paragraph.split(/\r?\n/);
    const caution = i > 0 && i === paragraphs.length - 1 && !lines.some((line) => LINK_LINE.test(line));
    const style = i === 0 ? LEAD_STYLE : caution ? CAUTION_STYLE : TEXT_STYLE;
    let pending: string[] = [];
    const flush = () => {
      if (pending.length) out.push(`<p style="${style}">${pending.join('<br>')}</p>`);
      pending = [];
    };
    for (const line of lines) {
      if (LINK_LINE.test(line)) {
        flush();
        out.push(button(values.link));
      } else if (KEY_LINE.test(line)) {
        flush();
        out.push(keyBox(values.agent_key));
      } else if (line.trim()) {
        pending.push(escapeHtml(fill(line, values)));
      }
    }
    flush();
  });
  return out.join('\n');
}

export function renderLinkEmail(
  happName: string,
  templates: { email_subject?: string; email_template?: string },
  values: LinkEmailValues,
): LinkEmail {
  const subject = fill(templates.email_subject ?? DEFAULT_SUBJECT, values);
  const template = templates.email_template ?? DEFAULT_TEMPLATE;
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background-color:${CARD.background}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${CARD.background}" style="background-color:${CARD.background}"><tr>
<td align="center" style="padding:32px 16px">
<!--[if mso]><table role="presentation" width="${CARD.width}" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${CARD.card}" style="max-width:${CARD.width}px;background-color:${CARD.card};border-radius:${CARD.cardRadius}"><tr>
<td align="center" style="padding:32px 24px 16px;text-align:center">
<p style="${TEXT_STYLE};margin-bottom:6px;font-size:14px;font-weight:600;letter-spacing:.02em">${escapeHtml(happName)}</p>
<h1 style="margin:0 0 20px;font-family:${FONT};font-size:22px;line-height:28px;font-weight:600;color:${CARD.heading};${WRAP}">${escapeHtml(subject)}</h1>
${bodyHtml(template, values)}
</td></tr></table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr></table>
</body>
</html>
`;
  return { subject, text: fill(template, values), html };
}
