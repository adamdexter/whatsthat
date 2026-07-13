'use strict';

const fs = require('fs');
const path = require('path');
const { render } = require('./template');
const { displayName } = require('./contacts');

const randBetween = (min, max) => Math.floor(min + Math.random() * (max - min + 1));

// Executes a campaign: sequentially renders + sends to each contact with a
// randomized delay between sends. One run at a time. Strict about data
// problems — a contact with an unknown/empty variable or a bad phone number
// is reported as failed rather than sent a broken message.
function createRunner({ wa, reportsDir }) {
  let current = null;

  async function start({ contacts, template, delayMinMs = 4000, delayMaxMs = 10000, onProgress = () => {} }) {
    if (current) throw new Error('A run is already in progress');
    if (!contacts || contacts.length === 0) throw new Error('No contacts to send to');
    if (!template || !String(template).trim()) throw new Error('The message template is empty');
    if (delayMaxMs < delayMinMs) [delayMinMs, delayMaxMs] = [delayMaxMs, delayMinMs];

    const run = { cancel: false };
    current = run;
    const startedAt = new Date();
    const results = [];

    // The report is rewritten after every contact so that a crash or Ctrl-C
    // mid-run never loses the record of who was already messaged.
    const reportFile = `run-${startedAt.toISOString().replace(/[:.]/g, '-')}.json`;
    const writeReport = (status) => {
      try {
        fs.mkdirSync(reportsDir, { recursive: true });
        fs.writeFileSync(
          path.join(reportsDir, reportFile),
          JSON.stringify(
            {
              status,
              summary: {
                startedAt: startedAt.toISOString(),
                finishedAt: status === 'complete' ? new Date().toISOString() : null,
                total: contacts.length,
                sent: results.filter((r) => r.status === 'sent').length,
                failed: results.filter((r) => r.status === 'failed').length,
                cancelled: results.filter((r) => r.status === 'cancelled').length,
              },
              template,
              results: results.map(({ contact, ...rest }) => ({
                ...rest,
                phone: contact.phone,
                fields: contact.fields,
              })),
            },
            null,
            2
          )
        );
        return true;
      } catch {
        // Report persistence must never mask the run result.
        return false;
      }
    };

    try {
      for (let i = 0; i < contacts.length; i++) {
        const contact = contacts[i];
        const name = displayName(contact);

        if (run.cancel) {
          const entry = { index: i, total: contacts.length, name, contact, status: 'cancelled' };
          results.push(entry);
          writeReport('running');
          onProgress({ type: 'progress', ...entry });
          continue;
        }

        const report = (status, extra = {}) => {
          const entry = { index: i, total: contacts.length, name, contact, status, ...extra };
          results.push(entry);
          writeReport('running');
          onProgress({ type: 'progress', ...entry });
        };

        const { text, unknown, empty } = render(template, contact.fields);
        if (unknown.length) {
          report('failed', { error: `Unknown variable(s): ${unknown.join(', ')}` });
          continue;
        }
        if (empty.length) {
          report('failed', { error: `Empty value(s) for: ${empty.join(', ')} — fix the sheet or deselect this contact` });
          continue;
        }
        if (!contact.phone) {
          report('failed', { error: `Invalid phone number: ${contact.phoneError}` });
          continue;
        }

        try {
          const chatId = await wa.checkNumber(contact.phone);
          if (!chatId) {
            report('failed', { error: 'This number is not registered on WhatsApp' });
          } else {
            await wa.send(chatId, text);
            report('sent', { text });
          }
        } catch (err) {
          report('failed', { error: err.message });
        }

        if (i < contacts.length - 1 && !run.cancel) {
          await new Promise((r) => setTimeout(r, randBetween(delayMinMs, delayMaxMs)));
        }
      }
    } finally {
      current = null;
    }

    const summary = {
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      total: contacts.length,
      sent: results.filter((r) => r.status === 'sent').length,
      failed: results.filter((r) => r.status === 'failed').length,
      cancelled: results.filter((r) => r.status === 'cancelled').length,
    };

    const reportOk = writeReport('complete');
    const done = { type: 'done', summary, reportFile: reportOk ? reportFile : null };
    onProgress(done);
    return { summary, results, reportFile: done.reportFile };
  }

  return {
    start,
    cancel() {
      if (current) current.cancel = true;
    },
    isRunning: () => Boolean(current),
  };
}

module.exports = { createRunner };
