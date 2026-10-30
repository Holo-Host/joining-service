import { CARD, FONT, MONO, escapeHtml } from './didit-with-email-card.js';

const DEFAULT_SUBJECT = 'Verify your identity to start using {{network}}';
const DEFAULT_TEMPLATE = `Thank you for downloading and installing the {{app}} Software to access the {{network}} network.

# Verify your identity
to start using {{network}}

Click to confirm your email address and start the KYC process. Please match the icon that appears on the next page.

{{link}}

You can ignore this message if you didn't install the {{app}} Software to access {{network}}.

If the button doesn't work, you can copy this link into a browser:
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
const HEADING_MARK = /^#[ \t]+/;
const WRAP = 'overflow-wrap:anywhere;word-break:break-word';
const TEXT_STYLE = `margin:0 0 16px;font-family:${FONT};font-size:15px;line-height:22px;color:${CARD.text};${WRAP}`;
const HEADING_STYLE = `margin:0 0 32px;font-family:${FONT};font-size:22px;line-height:28px;font-weight:600;color:${CARD.heading};${WRAP}`;
// No colour: the mail client's own text colour reads on its own light or dark background.
const ABOVE_STYLE = `margin:0 0 16px;font-family:${FONT};font-size:15px;line-height:22px;${WRAP}`;
const BELOW_STYLE = `${TEXT_STYLE};margin-bottom:8px;font-size:13px;line-height:20px;color:${CARD.muted}`;

type Values = LinkEmailValues & { app: string };

function fill(template: string, values: Values): string {
  return template.replace(/\{\{(app|network|link|expires_at|agent_key)\}\}/g, (_, key: keyof Values) => values[key]);
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

function paragraphHtml(lines: string[], tag: string, style: string, values: Values, buttons = true): string {
  const out: string[] = [];
  let pending: string[] = [];
  const flush = () => {
    if (pending.length) out.push(`<${tag} style="${style}">${pending.join('<br>')}</${tag}>`);
    pending = [];
  };
  for (const line of lines) {
    if (buttons && LINK_LINE.test(line)) {
      flush();
      out.push(button(values.link));
    } else if (KEY_LINE.test(line)) {
      flush();
      out.push(keyBox(values.agent_key));
    } else if (LINK_LINE.test(line)) {
      pending.push(`<span style="word-break:break-all">${escapeHtml(values.link)}</span>`);
    } else if (line.trim()) {
      pending.push(escapeHtml(fill(line, values)));
    }
  }
  flush();
  return out.join('\n');
}

/**
 * The heading is the paragraph marked `# `, or the first one. Paragraphs before it sit above the
 * card; the card ends with the paragraph that holds the button, and the rest sit below it, where a
 * line holding only `{{link}}` shows the link as text to copy.
 */
function sections(template: string, values: Values): { above: string; card: string; below: string } {
  const paragraphs = template
    .split(/\r?\n[ \t]*\r?\n/)
    .filter((p) => p.trim())
    .map((p) => p.split(/\r?\n/));
  const marked = paragraphs.findIndex((lines) => HEADING_MARK.test(lines[0]));
  const heading = Math.max(marked, 0);
  const buttonAt = paragraphs.findIndex((lines, i) => i >= heading && lines.some((line) => LINK_LINE.test(line)));
  const cardEnd = buttonAt < 0 ? paragraphs.length : buttonAt + 1;
  const render = (from: number, to: number, style: string, buttons = true) =>
    paragraphs
      .slice(from, to)
      .map((lines, i) =>
        from + i === heading
          ? paragraphHtml([lines[0].replace(HEADING_MARK, ''), ...lines.slice(1)], 'h1', HEADING_STYLE, values)
          : paragraphHtml(lines, 'p', style, values, buttons),
      )
      .join('\n');
  return { above: render(0, heading, ABOVE_STYLE), card: render(heading, cardEnd, TEXT_STYLE), below: render(cardEnd, paragraphs.length, BELOW_STYLE, false) };
}

export function renderLinkEmail(
  happName: string,
  templates: { email_subject?: string; email_template?: string },
  values: LinkEmailValues,
): LinkEmail {
  const all = { ...values, app: happName };
  const subject = fill(templates.email_subject ?? DEFAULT_SUBJECT, all);
  const template = templates.email_template ?? DEFAULT_TEMPLATE;
  const { above, card, below } = sections(template, all);
  const row = (html: string, padding: string) =>
    html ? `<tr><td align="left" style="padding:${padding};text-align:left">\n${html}\n</td></tr>\n` : '';
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
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
${row(above, '32px 16px 22px')}<tr><td align="center" style="padding:${above ? '0' : '32px'} 16px ${below ? '0' : '32px'}">
<!--[if mso]><table role="presentation" width="${CARD.width}" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${CARD.card}" style="max-width:${CARD.width}px;background-color:${CARD.card};border-radius:${CARD.cardRadius}"><tr>
<td align="center" style="padding:48px 32px 32px;text-align:center">
${card}
</td></tr></table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
${row(below, '38px 16px 32px')}</table>
</body>
</html>
`;
  const text = fill(template.replace(/(^|\r?\n[ \t]*\r?\n)#[ \t]+/, '$1'), all);
  return { subject, text, html };
}
