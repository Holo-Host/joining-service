export interface EmailParts {
  html?: string;
  /** Goes unescaped into a quoted From header, so it holds no CR, LF, `<`, `>`, `,`, `"` or `\`. */
  senderName?: string;
}

export interface EmailTransport {
  send(to: string, subject: string, body: string, parts?: EmailParts): Promise<void>;
}
