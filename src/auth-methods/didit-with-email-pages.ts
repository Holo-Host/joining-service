import type { DiditWithEmailState } from '../types.js';
import { NO_ATTEMPTS_LEFT, formatUtc, shortAgentKey } from './didit-with-email.js';
import { CARD, FONT, escapeHtml } from './didit-with-email-card.js';

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
  notPassedLanding: 'Your last verification did not pass. Continue to start a new attempt.',
  notFound: 'We could not find your verification. To start again, open the link in your email and press Continue.',
  rejected: NO_ATTEMPTS_LEFT,
  otherDevice: 'Another device is verifying this email. Finish there, or try again when it ends.',
};

const STYLE = `*{box-sizing:border-box}
html{background:${CARD.background};color-scheme:dark}
body{margin:0;min-height:100vh;min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:16px;font:15px/1.5 ${FONT};color:${CARD.text};text-align:center;-webkit-text-size-adjust:100%}
main{width:100%;max-width:${CARD.width}px;padding:32px 24px;background:${CARD.card};border:1px solid rgba(255,255,255,.08);border-radius:${CARD.cardRadius};box-shadow:0 12px 40px rgba(0,0,0,.35)}
.app{margin:0 0 6px;font-size:14px;font-weight:600;letter-spacing:.02em}
h1{margin:0 0 20px;font-size:22px;line-height:1.3;font-weight:600;color:${CARD.heading}}
p{margin:0 0 12px}
p:last-child{margin-bottom:0}
form{margin:24px 0 0}
button{width:100%;min-height:44px;padding:10px 20px;border:0;border-radius:${CARD.buttonRadius};background:${CARD.button};color:${CARD.buttonText};font:600 15px/1.5 ${FONT};cursor:pointer}
button:hover{background:#0a5fbe}
button:focus-visible{outline:2px solid ${CARD.heading};outline-offset:3px}`;

export function linkPages(happName: string) {
  function page(paragraphs: string[], status: number, form = ''): Response {
    const body = paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('\n');
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
${body}
${form}
</main>
</body>
</html>
`;
    return new Response(html, { status, headers: PAGE_HEADERS });
  }

  function message(text: string, status = 200): Response {
    return page([text], status);
  }

  return {
    message,

    landing(request: { network: string; startedAt: number; agentKey: string; state: DiditWithEmailState }): Response {
      const { network, state } = request;
      const paragraphs = [
        `Someone started joining ${network} with this email address on ${formatUtc(request.startedAt)}.`,
        `This request is for the device with agent key ${shortAgentKey(request.agentKey)}. Continue only if that is the key shown in your app.`,
      ];
      if (state === 'approved') return page([...paragraphs, TEXT.approvedLanding], 200);
      if (state === 'in_review') return page([...paragraphs, TEXT.inReview], 200);

      paragraphs.push(`Did you start joining ${network}? If not, close this page and do not continue.`);
      if (state === 'declined' || state === 'expired') paragraphs.push(TEXT.notPassedLanding);
      return page(paragraphs, 200, '<form method="post"><button type="submit">Continue</button></form>');
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
