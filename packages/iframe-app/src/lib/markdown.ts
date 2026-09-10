import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { safeAssetUrl } from './binary.js';

export function releaseNotesHtml(notes: string): string {
  const clean = DOMPurify.sanitize(marked.parse(notes, { async: false, gfm: true }), {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['form', 'input', 'button', 'style'],
    FORBID_ATTR: ['style'],
  });
  const template = document.createElement('template');
  template.innerHTML = clean;
  for (const link of template.content.querySelectorAll('a')) {
    const href = safeAssetUrl(link.getAttribute('href'));
    if (href) {
      link.href = href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    } else link.removeAttribute('href');
  }
  // Do not make unsolicited third-party tracking requests from signed notes.
  for (const image of template.content.querySelectorAll('img')) image.remove();
  return template.innerHTML;
}
