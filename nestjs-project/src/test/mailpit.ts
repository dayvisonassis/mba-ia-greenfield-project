const mailpitUrl = `http://${process.env.MAIL_HOST ?? 'mailpit'}:8025`;

/**
 * Minimal typings for the Mailpit REST API (v1), covering only the fields the
 * test suite reads. Typed rather than `any` so a change in what a test asserts
 * on fails `tsc --noEmit` instead of silently reading `undefined`.
 *
 * Field names are Mailpit's own (PascalCase) — do not rename them.
 */

export interface MailpitAddress {
  Name: string;
  Address: string;
}

export interface MailpitMessageSummary {
  ID: string;
  MessageID: string;
  Subject: string;
  From: MailpitAddress | null;
  To: MailpitAddress[];
  Snippet: string;
  Read: boolean;
  Created: string;
}

export interface MailpitMessageDetail extends MailpitMessageSummary {
  Text: string;
  HTML: string;
}

interface MailpitMessagesResponse {
  messages: MailpitMessageSummary[];
  total: number;
}

export async function getMailpitMessages(): Promise<MailpitMessageSummary[]> {
  const res = await fetch(`${mailpitUrl}/api/v1/messages`);
  const data = (await res.json()) as MailpitMessagesResponse;
  return data.messages ?? [];
}

export async function getMailpitMessage(
  id: string,
): Promise<MailpitMessageDetail> {
  const res = await fetch(`${mailpitUrl}/api/v1/message/${id}`);
  return (await res.json()) as MailpitMessageDetail;
}

export async function clearMailpitMessages(): Promise<void> {
  await fetch(`${mailpitUrl}/api/v1/messages`, { method: 'DELETE' });
}
