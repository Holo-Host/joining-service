import type { DiditWithEmailState } from '../types.js';
import { NO_ATTEMPTS_LEFT } from './didit-with-email.js';
import { CARD, FONT, escapeHtml } from './didit-with-email-card.js';
import { identiconSvg } from './didit-with-email-identicon.js';

const PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
};

export const TEXT = {
  invalid: 'This link is no longer valid, or this join is finished. Open the app to continue.',
  unavailable: 'Identity verification is not available right now. Try the link again in a few minutes.',
  approved: 'Your identity is verified. Go back to the app. It finishes joining by itself.',
  approvedLanding: 'Your identity is verified. Go back to the app.',
  inReview: 'Your verification is in review. After the review, the app continues by itself.',
  inProgress: 'Your verification is still in progress. Go back to the app. It continues by itself.',
  notPassed: 'Your verification did not pass. To try again, open the link in your email again.',
  notPassedLanding: 'Your last verification did not pass. Check the icon below to start a new attempt.',
  notFound: 'We could not find your verification. To start again, open the link in your email.',
  rejected: NO_ATTEMPTS_LEFT,
  otherDevice: 'Another device is verifying this email. Finish there, or try again when it ends.',
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
.match{display:flex;align-items:center;gap:16px;margin:0 0 12px;padding:16px;background:${CARD.button};border-radius:${CARD.buttonRadius};text-align:left}
.match p{margin:0;font-weight:600;color:${CARD.buttonText}}
.identicon{flex:none;width:80px;height:80px;border-radius:50%}
form{margin:20px 0 0}
button{width:100%;min-height:44px;padding:10px 20px;border:0;border-radius:${CARD.buttonRadius};background:${CARD.button};color:${CARD.buttonText};font:600 15px/1.5 ${FONT};cursor:pointer}
button:hover{background:#0a5fbe}
button:focus-visible{outline:2px solid ${CARD.heading};outline-offset:3px}`;

export function linkPages(happName: string) {
  function page(status: number, heading: string, body: string): Response {
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
<h1>${escapeHtml(heading)}</h1>
${body}
</main>
</body>
</html>
`;
    return new Response(html, { status, headers: PAGE_HEADERS });
  }

  function message(text: string, status = 200): Response {
    return page(status, 'Identity verification', `<p class="lead">${escapeHtml(text)}</p>`);
  }

  return {
    message,

    landing({ network, agentKey, state }: { network: string; agentKey: string; state: DiditWithEmailState }): Response {
      if (state === 'approved') return message(TEXT.approvedLanding);
      if (state === 'in_review') return message(TEXT.inReview);
      const failed = state === 'declined' || state === 'expired' ? `<p class="lead">${escapeHtml(TEXT.notPassedLanding)}</p>\n` : '';
      const body = `${failed}<div class="match">${identiconSvg(agentKey)}<p>${escapeHtml(`Ensure this matches in the ${happName} App`)}</p></div>
<p>Do not proceed if the agent icon doesn't match.</p>
<form method="post"><button type="submit">Yes-- Image matches (OK)</button></form>`;
      return page(200, `Verify your identity to start using ${network}`, body);
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
