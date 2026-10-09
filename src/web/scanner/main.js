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
// Once the phone has connected to the computer, the phone's vision starts (vision.js, T-0326;
// not before, T-0329): it finds the printed
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
import { startPhoneVision } from './vision.js';

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

function show(state) {
  statusLine.dataset.status = state;
  statusLine.textContent = MESSAGES[state] ?? MESSAGES.error;
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
  let visionStarted = false;

  session.onStatus((state, detail) => {
    show(state === 'error' && (detail === 'wrong-password' || detail === 'timeout') ? detail : state);
    // Why an 'error' happened, for diagnosis (the harness reads it; T-0316). Not shown.
    statusLine.dataset.detail = state === 'error' ? String(detail ?? '') : '';

    // The vision starts once the phone has first connected, never before (T-0329). Loading
    // OpenCV and finding the board while the connection is still being set up slowed pairing about
    // four times over (public relays, studio and phone in one browser from file://: 11.9-14.3 s
    // without it, 47.8-56.6 s with it), long enough for the page to tell the person it could not
    // reach the computer. Its results are for the computer anyway, and the camera streams either
    // way. It keeps running if the computer leaves and comes back.
    if (state === 'connected' && !visionStarted) {
      visionStarted = true;
      startPhoneVision({
        video,
        stream,
        overlay: document.getElementById('scanner-overlay'),
        status: document.getElementById('scanner-vision'),
        send: message => session.sendVision(message),
      }).catch(error => console.error('vision', error));
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
