// The phone scanner page (T-0313), served at /scanner. Reads the session from the link's hash,
// asks for the rear camera, shows it full screen, and streams it to the computer that showed the
// QR code. src/web/vite.scanner.config.js builds scanner/index.html and this script into one
// file, build/scanner/index.html, which make_page.py copies to build/www/scanner/index.html.
// The HTML holds no comment, because the built page keeps them and the page is public.
//
// The status line's text is for the person holding the phone; its `data-status` attribute
// ('starting', 'invalid-link', 'camera-refused', 'connecting', 'connected', 'disconnected',
// 'wrong-password', 'timeout', 'error') is for tests/harness/test_scan_link.py.
//
// The phone's vision (vision.js, T-0326) loads while the phone connects and runs once it has
// connected (not before, T-0329): it finds the printed
// board, the camera's pose over it and the rock's outline, draws them over the picture, says what
// it sees in a second line (#scanner-vision, its state in `data-state`), and sends a summary to
// the computer through the session. It never holds up the camera or the connection.

import '../../site/theme.js';
import './scanner.css';
import { getRelaySockets, joinRoom } from 'trystero';
import {
  createScanSession,
  decodeScanHash,
  joinScanSession,
  SCAN_APP_ID,
} from '../src/lib/scan_link.js';
import { encodeScanHash, newScanSecrets } from '../src/lib/scan_link_hash.js';
import { CONNECTION_DIAGRAM_CSS, createConnectionDiagram } from '../src/lib/connection_diagram.js';
import { startPhoneVision } from './vision.js';

/** How long the connection picture stays once connected before it folds away (ms). */
export const CONNECTED_FOLD_MS = 3000;

const MESSAGES = {
  'invalid-link': 'This link is invalid or has expired. Scan the QR code on your computer again.',
  'camera-refused': 'The camera was refused. Allow camera access for this page in your browser settings, then reload.',
  'no-camera': 'This device has no camera this page can use.',
  connecting: 'Connecting to your computer...',
  connected: 'Connected. Your camera is streaming to your computer.',
  disconnected: 'Your computer ended the session. Scan a new QR code to start again.',
  'wrong-password': 'This link is invalid or has expired. Scan the QR code on your computer again.',
  timeout: 'Still trying to reach your computer. If its QR code has changed, this link has expired: scan the new one. Both devices must be on the same network.',
  error: 'Could not connect to your computer. Make sure both are on the same network, then scan the QR code again.',
};

const video = document.getElementById('scanner-video');
const statusLine = document.getElementById('scanner-status');
const connectionBox = document.getElementById('scanner-connection');

function show(state) {
  statusLine.dataset.status = state;
  statusLine.textContent = MESSAGES[state] ?? MESSAGES.error;
}

// The connection picture (T-0342) and the step it shows. While the session is 'connecting', the
// status line says the step (scan_trace.js stepText: "Connecting to the servers… (3 of 8)",
// then "Looking for your computer…" once more than half are up, ...); a failure, a timeout and 'connected' keep their messages
// above. The step is in the line's `data-phase` for the harness.
let diagram = null;
let foldTimer = null;
let latestStatus = 'connecting';
let latestTrace = null;

function showConnection() {
  if (!diagram && connectionBox) {
    const style = document.createElement('style');
    style.textContent = CONNECTION_DIAGRAM_CSS;
    document.head.append(style);
    diagram = createConnectionDiagram(connectionBox, { role: 'phone', label: 'How the connection to your computer is going' });
    connectionBox.hidden = false;
  }

  const failed = latestStatus === 'error' || latestStatus === 'disconnected';
  diagram?.update({ ...(latestTrace ?? { step: 'servers' }), error: failed });
  statusLine.dataset.phase = latestTrace?.step ?? 'servers';

  // Past the phone's 30 s timeout ('connecting-slow') it is still trying: the step goes on
  // showing, with why it may be slow.
  if ((latestStatus === 'connecting' || latestStatus === 'connecting-slow') && latestTrace) {
    statusLine.textContent = latestStatus === 'connecting-slow'
      ? `${latestTrace.text} This is taking longer than usual: both devices must be on the same network, with no VPN.`
      : latestTrace.text;
  }

  clearTimeout(foldTimer);

  if (latestStatus === 'connected') {
    foldTimer = setTimeout(() => connectionBox?.classList.add('folded'), CONNECTED_FOLD_MS);
  } else {
    connectionBox?.classList.remove('folded');
  }
}

// The harness drives both ends of a session from this page (as it drives the app through
// window.gemApp): the host side, a joiner with a chosen password, Trystero's own joinRoom for a
// joiner that bypasses this module entirely, and Trystero's relay sockets, to see them closed
// after a session. None of it is reachable from the page's UI.
globalThis.housekiScanLink = {
  createScanSession,
  joinScanSession,
  decodeScanHash,
  encodeScanHash,
  newScanSecrets,
  joinRoom,
  getRelaySockets,
  SCAN_APP_ID,
};

async function start() {
  if (!location.hash) {
    show('invalid-link');
    return;
  }

  let link;

  try {
    link = decodeScanHash(location.hash);
  } catch {
    show('invalid-link');
    return;
  }

  statusLine.dataset.status = 'starting';

  let stream;

  try {
    // `ideal`, not `exact`: a phone uses its rear camera, and a laptop with only a front webcam
    // still streams (the user tests with the phone page open on the computer itself). 1280 x 720
    // is asked for, again only as an ideal: browsers otherwise default to 640 x 480, and the
    // board's pose is the more precise the more pixels its corners have; a phone in portrait
    // gives 720 x 1280.
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
  } catch (cause) {
    const refused = cause && (cause.name === 'NotAllowedError' || cause.name === 'SecurityError');
    show(refused ? 'camera-refused' : 'no-camera');
    return;
  }

  video.srcObject = stream;
  show('connecting');

  const session = joinScanSession(link, stream);

  // The vision starts loading now, while the session connects, but reads no frame until the phone
  // has first connected (T-0329: loading OpenCV and finding the board while the connection was
  // still being set up slowed pairing about four times over -- public relays, studio and phone in
  // one browser from file://: 11.9-14.3 s without it, 47.8-56.6 s with it). The load runs in a
  // Worker, off this thread; where it cannot, vision.js waits for `connected` before loading in
  // the page. Once connected, its status line says whether the board finder is still loading.
  // Its results are for the computer anyway, and the camera streams either way. It keeps running
  // if the computer leaves and comes back.
  let markConnected;
  const connected = new Promise(resolve => {
    markConnected = resolve;
  });
  startPhoneVision({
    video,
    stream,
    overlay: document.getElementById('scanner-overlay'),
    status: document.getElementById('scanner-vision'),
    send: message => session.sendVision(message),
    connected,
  }).catch(error => console.error('vision', error));

  session.onTrace(snapshot => {
    latestTrace = snapshot;
    showConnection();
  });

  session.onStatus((state, detail) => {
    show(state === 'error' && (detail === 'wrong-password' || detail === 'timeout') ? detail : state);
    latestStatus = state === 'error' && detail === 'timeout' ? 'connecting-slow' : state;
    showConnection();
    // Why an 'error' happened, for diagnosis (the harness reads it; T-0316). Not shown.
    statusLine.dataset.detail = state === 'error' ? String(detail ?? '') : '';

    if (state === 'connected') {
      markConnected();
    }
  });

  addEventListener('pagehide', () => session.close());
}

// A new link opened in a tab that already shows this page differs from the old one only in its
// hash, and the browser does not load the page again for that: without this, the page stayed in
// the old session's room and the computer waited for ever (T-0316: easy to hit when testing with
// the "phone" as a second tab, pasting each new link into the same tab). Loading afresh leaves the old room (pagehide) and joins the
// new one.
addEventListener('hashchange', () => location.reload());

start();
