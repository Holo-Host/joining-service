import type { DiditWithEmailState } from '../types.js';
import { NO_ATTEMPTS_LEFT, formatUtc, shortAgentKey } from './didit-with-email.js';

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
};

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function page(paragraphs: string[], status: number, form = ''): Response {
  const body = paragraphs.map((p) => `<p>${escape(p)}</p>`).join('\n');
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Identity verification</title>
<style>body{font-family:system-ui,sans-serif;max-width:34rem;margin:2rem auto;padding:0 1rem;line-height:1.5}button{font:inherit;padding:.6rem 1.6rem}</style>
</head>
<body>
<h1>Identity verification</h1>
${body}
${form}
</body>
</html>
`;
  return new Response(html, { status, headers: PAGE_HEADERS });
}

export function messagePage(text: string, status = 200): Response {
  return page([text], status);
}

export function redirectTo(url: string): Response {
  return new Response(null, { status: 303, headers: { ...PAGE_HEADERS, Location: url } });
}

/** `GET /v1/didit/{token}`: the request, and a Continue button while there is something to continue. */
export function landingPage(request: {
  network: string;
  startedAt: number;
  agentKey: string;
  state: DiditWithEmailState;
}): Response {
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
}

/** `GET /v1/didit/done/{credential}`: where the verification stands. */
export function donePage(state: DiditWithEmailState): Response {
  if (state === 'approved') return messagePage(TEXT.approved);
  if (state === 'in_review') return messagePage(TEXT.inReview);
  if (state === 'in_progress') return messagePage(TEXT.inProgress);
  if (state === 'link_sent') return messagePage(TEXT.notFound);
  return messagePage(TEXT.notPassed);
}
