import { createHash } from 'node:crypto';
import type { DiditWithEmailState } from '../types.js';
import { NO_ATTEMPTS_LEFT } from './didit-with-email.js';
import { CARD, FONT, MONO, escapeHtml } from './didit-with-email-card.js';

const COPY_SCRIPT =
  "const b=document.getElementById('copy'),k=document.getElementById('key'),f=document.getElementById('copy-failed');if(navigator.clipboard){b.hidden=false;b.onclick=()=>navigator.clipboard.writeText(k.textContent).then(()=>{b.textContent='Copied'},()=>{b.hidden=true;f.hidden=false;getSelection().selectAllChildren(k)})}";

const PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex',
  'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${createHash('sha256').update(COPY_SCRIPT).digest('base64')}'; frame-ancestors 'none'`,
};

export const TEXT = {
  invalid: 'This link is no longer valid, or this join is finished. Open the app to continue.',
  unavailable: 'Identity verification is not available right now. Try the link again in a few minutes.',
  approved: 'Your identity is verified. Go back to the app. It finishes joining by itself.',
  approvedLanding: 'Your identity is verified. Go back to the app.',
  inReview: 'Your verification is in review. After the review, the app continues by itself.',
  inProgress: 'Your verification is still in progress. Go back to the app. It continues by itself.',
  notPassed: 'Your verification did not pass. To try again, open the link in your email again.',
  notPassedLanding: 'Your last verification did not pass. Continue to start a new attempt.',
  notFound: 'We could not find your verification. To start again, open the link in your email and press Continue.',
  rejected: NO_ATTEMPTS_LEFT,
  otherDevice: 'Another device is verifying this email. Finish there, or try again when it ends.',
  keyIntro: 'For the device with this agent key:',
  keyCheck: 'Continue only if that is the key shown in your app.',
  copyFailed: 'Your browser did not allow copying. Select the key and copy it.',
  caution: 'If you did not start this, close this page and do not continue.',
};

const LANDING_LEAD: Partial<Record<DiditWithEmailState, string>> = {
  approved: TEXT.approvedLanding,
  in_review: TEXT.inReview,
  declined: TEXT.notPassedLanding,
  expired: TEXT.notPassedLanding,
};

const STYLE = `*{box-sizing:border-box}
html{background:${CARD.background};color-scheme:dark}
body{margin:0;min-height:100vh;min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:16px;font:15px/1.5 ${FONT};color:${CARD.text};text-align:center;-webkit-text-size-adjust:100%}
main{width:100%;max-width:${CARD.width}px;padding:32px 24px;background:${CARD.card};border:1px solid rgba(255,255,255,.08);border-radius:${CARD.cardRadius};box-shadow:0 12px 40px rgba(0,0,0,.35)}
.app{margin:0 0 6px;font-size:14px;font-weight:600;letter-spacing:.02em}
h1{margin:0 0 16px;font-size:22px;line-height:1.3;font-weight:600;color:${CARD.heading}}
p{margin:0 0 12px}
p:last-child{margin-bottom:0}
.lead{font-weight:600;color:${CARD.heading}}
.key{display:flex;align-items:center;gap:8px;margin:0 0 12px;padding:8px 8px 8px 12px;background:${CARD.keyBox};border:1px solid ${CARD.keyBorder};border-radius:${CARD.buttonRadius};text-align:left}
.key code{flex:1;min-width:0;font:13px/1.5 ${MONO};color:${CARD.heading};overflow-wrap:anywhere;word-break:break-word;-webkit-user-select:all;user-select:all}
.caution{margin-top:20px;font-size:13px;color:${CARD.muted}}
form{margin:20px 0 0}
button{width:100%;min-height:44px;padding:10px 20px;border:0;border-radius:${CARD.buttonRadius};background:${CARD.button};color:${CARD.buttonText};font:600 15px/1.5 ${FONT};cursor:pointer}
button:hover{background:#0a5fbe}
button:focus-visible{outline:2px solid ${CARD.heading};outline-offset:3px}
.key button{width:auto;min-width:64px;padding:0 12px;background:#2a2a30;font-size:13px}
.key button:hover{background:#3a3a42}`;

export function linkPages(happName: string) {
  function page(status: number, lead: string, more: { body?: string; caution?: string } = {}): Response {
    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Identity verification</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<p class="app">${escapeHtml(happName)}</p>
<h1>Identity verification</h1>
<p class="lead">${escapeHtml(lead)}</p>
${more.body ?? ''}
${more.caution ? `<p class="caution">${escapeHtml(more.caution)}</p>` : ''}
</main>
</body>
</html>
`;
    return new Response(html, { status, headers: PAGE_HEADERS });
  }

  function message(text: string, status = 200): Response {
    return page(status, text);
  }

  return {
    message,

    landing({ network, agentKey, state }: { network: string; agentKey: string; state: DiditWithEmailState }): Response {
      const request = `Request to verify your identity to join ${network} with this email address.`;
      const lead = LANDING_LEAD[state];
      const body = `${lead ? `<p>${escapeHtml(request)}</p>\n` : ''}<p>${escapeHtml(TEXT.keyIntro)}</p>
<div class="key"><code id="key">${escapeHtml(agentKey)}</code><button type="button" id="copy" aria-live="polite" hidden>Copy</button></div>
<p id="copy-failed" role="status" hidden>${escapeHtml(TEXT.copyFailed)}</p>
<script>${COPY_SCRIPT}</script>
<p>${escapeHtml(TEXT.keyCheck)}</p>`;
      if (state === 'approved' || state === 'in_review') return page(200, lead!, { body });
      return page(200, lead ?? request, {
        body: `${body}\n<form method="post"><button type="submit">Continue</button></form>`,
        caution: TEXT.caution,
      });
    },

    done(state: DiditWithEmailState): Response {
      if (state === 'approved') return message(TEXT.approved);
      if (state === 'in_review') return message(TEXT.inReview);
      if (state === 'in_progress') return message(TEXT.inProgress);
      if (state === 'link_sent') return message(TEXT.notFound);
      return message(TEXT.notPassed);
    },
  };
}

export function redirectTo(url: string): Response {
  return new Response(null, { status: 303, headers: { ...PAGE_HEADERS, Location: url } });
}
