// @vitest-environment jsdom
//
// The assist panel's waiting feedback. These cover the gap that let an earlier stream
// decoding bug pass a manual test: between the send and the first word of the reply the
// browser receives nothing for several seconds, and the panel must say so visibly.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fireEvent, screen, cleanup, waitFor } from '@testing-library/react';
import { h, renderWithApp } from './harness.js';
import { AIChatPanel } from '../AIChatPanel.jsx';
import { StorageAdapter } from '../../storage/adapter.js';

const draft = { name: 'Test', description: '', query: 'SigninLogs | take 1' };

/** A chat response whose body streams `lines` only when `release` is resolved. */
function heldStream(lines, release) {
  const encoder = new TextEncoder();
  return {
    ok: true,
    body: {
      getReader: () => {
        let sent = false;
        return {
          read: async () => {
            if (sent) return { done: true, value: undefined };
            await release;
            sent = true;
            return { done: false, value: encoder.encode(lines.join('\n') + '\n') };
          },
        };
      },
    },
  };
}

const open = (props = {}) => renderWithApp(
  h(AIChatPanel, { draft, schemas: [], onProposal: () => {}, onClose: () => {}, ...props }), {},
);

const send = (text) => {
  fireEvent.change(screen.getByLabelText('Message the AI assistant'), { target: { value: text } });
  fireEvent.click(screen.getByLabelText('Send message'));
};

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('AIChatPanel waiting feedback', () => {
  it('shows the thinking indicator while the model is silent, and clears it when text arrives', async () => {
    let releaseStream;
    const held = new Promise((r) => { releaseStream = r; });
    vi.spyOn(StorageAdapter, 'aiRedact').mockResolvedValue({ blocked: false, applied: [] });
    vi.spyOn(StorageAdapter, 'aiChat').mockResolvedValue(
      heldStream([JSON.stringify({ type: 'text', value: 'Here is a rewrite.' })], held),
    );

    open();
    send('tighten this');
    // Confirm the redaction gate so the request actually goes out.
    fireEvent.click(await screen.findByText('Send'));

    // Dead air: streaming, nothing received yet.
    expect(await screen.findByText('Thinking…')).toBeTruthy();
    expect(screen.getByText('The model is responding…')).toBeTruthy();

    releaseStream();

    // First content chunk replaces the indicator with the reply itself.
    expect(await screen.findByText('Here is a rewrite.')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('Thinking…')).toBeNull());
  });

  it('returns to the quiet hint once the turn is over', async () => {
    vi.spyOn(StorageAdapter, 'aiRedact').mockResolvedValue({ blocked: false, applied: [] });
    vi.spyOn(StorageAdapter, 'aiChat').mockResolvedValue(
      heldStream([JSON.stringify({ type: 'text', value: 'done' })], Promise.resolve()),
    );

    open();
    send('tighten this');
    fireEvent.click(await screen.findByText('Send'));

    await screen.findByText('done');
    await waitFor(() => {
      expect(screen.queryByText('The model is responding…')).toBeNull();
      expect(screen.getByText(/Enter to send/)).toBeTruthy();
    });
  });

  it('keeps both turns of the conversation on screen', async () => {
    vi.spyOn(StorageAdapter, 'aiRedact').mockResolvedValue({ blocked: false, applied: [] });
    vi.spyOn(StorageAdapter, 'aiChat').mockResolvedValue(
      heldStream([JSON.stringify({ type: 'text', value: 'the model reply' })], Promise.resolve()),
    );

    open();
    send('my instruction');
    fireEvent.click(await screen.findByText('Send'));

    await screen.findByText('the model reply');
    expect(screen.getByText('my instruction')).toBeTruthy();
  });
});
