import { CARD, FONT, MONO, escapeHtml } from './didit-with-email-card.js';

const DEFAULT_SUBJECT = 'Verify your identity to start using {{network}}';
const DEFAULT_TEMPLATE = `Verify your identity to start using {{network}}

{{link}}`;

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
const HEADING_STYLE = `margin:0 0 32px;font-family:${FONT};font-size:22px;line-height:28px;font-weight:600;color:${CARD.heading};${WRAP}`;
const CAUTION_STYLE = `${TEXT_STYLE};margin-top:4px;font-size:13px;line-height:20px;color:${CARD.muted}`;

function fill(template: string, values: LinkEmailValues): string {
  return template.replace(/\{\{(network|link|expires_at|agent_key)\}\}/g, (_, key: keyof LinkEmailValues) => values[key]);
}

function button(link: string): string {
  const href = escapeHtml(link);
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px"><tr>
<td align="center" bgcolor="${CARD.button}" style="border-radius:${CARD.buttonRadius};background-color:${CARD.button}">
<a href="${href}" style="display:block;padding:12px 20px;border-radius:${CARD.buttonRadius};font-family:${FONT};font-size:15px;font-weight:600;line-height:20px;color:${CARD.buttonText};text-decoration:none">Verify your Identity</a>
</td></tr></table>`;
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
    const [tag, style] = i === 0 ? ['h1', HEADING_STYLE] : ['p', caution ? CAUTION_STYLE : TEXT_STYLE];
    let pending: string[] = [];
    const flush = () => {
      if (pending.length) out.push(`<${tag} style="${style}">${pending.join('<br>')}</${tag}>`);
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
<body style="margin:0;padding:0">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td align="center" style="padding:32px 16px">
<!--[if mso]><table role="presentation" width="${CARD.width}" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${CARD.card}" style="max-width:${CARD.width}px;background-color:${CARD.card};border-radius:${CARD.cardRadius}"><tr>
<td align="center" style="padding:48px 32px 32px;text-align:center">
<p style="${TEXT_STYLE};margin-bottom:24px;font-size:22px;line-height:28px;font-weight:600">${escapeHtml(happName)}</p>
${bodyHtml(template, values)}
</td></tr></table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr></table>
</body>
</html>
`;
  return { subject, text: fill(template, values), html };
}
