/** The Unyt app's join card, in solid colours. */
export const CARD = {
  background: '#373741',
  card: '#1c1c21',
  heading: '#ffffff',
  text: '#bbbbbc',
  button: '#084fa2',
  buttonText: '#ffffff',
  cardRadius: '12px',
  buttonRadius: '6px',
  width: 440,
} as const;

/** System fonts only: the pages' CSP blocks a remote font, and the email loads nothing remote. */
export const FONT = "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
