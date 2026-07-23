'use strict';

// WhatsApp text markup → safe preview HTML, mirroring how WhatsApp renders a
// sent message: *bold*, _italic_, ~strike~, ```monospace block```, and
// `inline code`. Markers only take effect when they hug their content
// (*text* formats, * text * stays literal) and never span line breaks —
// except ``` blocks, which do. Unmatched markers stay literal, like in
// WhatsApp itself. Everything is HTML-escaped first: contact-sheet data
// flows through here.

const waEscapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function waFormatToHtml(text) {
  // NUL delimits stashed code spans below — it can't survive in the input.
  let out = waEscapeHtml(String(text).replace(/\0/g, ''));

  // Code spans are rendered literally by WhatsApp — stash them so the
  // bold/italic/strike passes can't reformat their contents.
  const stash = [];
  const stashIt = (html) => '\0' + (stash.push(html) - 1) + '\0';
  out = out.replace(/```([\s\S]+?)```/g, (m, body) => stashIt(`<code>${body}</code>`));
  out = out.replace(/`([^`\n]+?)`/g, (m, body) => stashIt(`<code>${body}</code>`));

  out = out.replace(/\*(?!\s)([^*\n]+?)(?<!\s)\*/g, '<b>$1</b>');
  out = out.replace(/_(?!\s)([^_\n]+?)(?<!\s)_/g, '<i>$1</i>');
  out = out.replace(/~(?!\s)([^~\n]+?)(?<!\s)~/g, '<s>$1</s>');

  return out.replace(/\0(\d+)\0/g, (m, i) => stash[Number(i)]);
}

// Loaded as a plain <script> in the browser; require()d in node tests.
if (typeof module !== 'undefined') module.exports = { waFormatToHtml };
