const form = document.querySelector('#registration-form');
const statusMessage = document.querySelector('#form-status');
const adminOverlay = document.querySelector('#admin-overlay');
const registrationPanel = document.querySelector('#registration-panel');
const openAdminLogin = document.querySelector('#open-admin-login');
const closeAdminLogin = document.querySelector('#close-admin-login');
const adminLoginForm = document.querySelector('#admin-login-form');
const adminStatus = document.querySelector('#admin-status');
const adminDashboard = document.querySelector('#admin-dashboard');
const adminLogout = document.querySelector('#admin-logout');
const dashboardTabs = document.querySelectorAll('.dashboard-tab');
const dashboardViews = document.querySelectorAll('.dashboard-view');
const verifyPassButton = document.querySelector('#verify-pass');
const manualPass = document.querySelector('#manual-pass');
const scannerStatus = document.querySelector('#scanner-status');
const registrationsBody = document.querySelector('#registrations-body');
const recordCount = document.querySelector('#record-count');
const registrationsStatus = document.querySelector('#registrations-status');
const startCameraButton = document.querySelector('#start-camera');
const scannerVideo = document.querySelector('#scanner-video');
const scannerFrame = document.querySelector('#scanner-frame');
const scannerCameraStatus = document.querySelector('#scanner-camera-status');
const verificationDetails = document.querySelector('#verification-details');
const successPanel = document.querySelector('#registration-success');
const successName = document.querySelector('#success-name');
const getQrCodeButton = document.querySelector('#get-qr-code');
const qrResult = document.querySelector('#qr-result');
const qrCode = document.querySelector('#qr-code');
const qrPassId = document.querySelector('#qr-pass-id');
const downloadQrButton = document.querySelector('#download-qr-code');
const submitButton = form.querySelector('button[type="submit"]');
const apiBase = window.EVENT_API_BASE || (
  ['localhost', '127.0.0.1'].includes(window.location.hostname)
    && window.location.port
    && window.location.port !== '3000'
    ? 'http://localhost:3000'
    : ''
);

let registrationQrDataUrl = '';

let scannerStream = null;
let scannerLoopActive = false;

const fields = {
  name: {
    input: document.querySelector('#name'),
    error: document.querySelector('#name-error'),
    validate: (value) => value.trim().length >= 2 ? '' : 'Please  full name.'
  },
  email: {
    input: document.querySelector('#email'),
    error: document.querySelector('#email-error'),
    validate: (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()) ? '' : 'Please enter a valid email address.'
  },
  phone: {
    input: document.querySelector('#phone'),
    error: document.querySelector('#phone-error'),
    validate: (value) => value.replace(/\D/g, '').length >= 10 ? '' : 'Please enter a valid phone number.'
  },
  illuminateId: {
    input: document.querySelector('#illuminate-id'),
    error: document.querySelector('#illuminate-id-error'),
    validate: (value) => value.trim().length >= 3 ? '' : 'Please  Illuminate ID.'
  }
};

function validateField(field) {
  const message = field.validate(field.input.value);
  field.error.textContent = message;
  field.input.setAttribute('aria-invalid', String(Boolean(message)));
  return !message;
}

Object.values(fields).forEach((field) => {
  field.input.addEventListener('blur', () => validateField(field));
  field.input.addEventListener('input', () => {
    if (field.input.getAttribute('aria-invalid') === 'true') {
      validateField(field);
    }
  });
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  statusMessage.textContent = '';

  const isValid = Object.values(fields).every(validateField);
  if (!isValid) {
    const firstInvalid = Object.values(fields).find((field) => field.input.getAttribute('aria-invalid') === 'true');
    firstInvalid.input.focus();
    return;
  }

  try {
    const response = await fetch(`${apiBase}/api/events/illuminate-2026/registrations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: fields.name.input.value,
        email: fields.email.input.value,
        phone: fields.phone.input.value,
        illuminateId: fields.illuminateId.input.value
      })
    });
    const result = await response.json();

    if (!response.ok) {
      statusMessage.textContent = result.error || 'Registration could not be completed.';
      return;
    }

    registrationQrDataUrl = result.qrDataUrl;
    successName.textContent = result.name;
    qrPassId.textContent = result.passId;
    qrResult.hidden = true;
    getQrCodeButton.hidden = false;
    registrationPanel.hidden = true;
    successPanel.classList.remove('is-visible');
    successPanel.hidden = false;
    requestAnimationFrame(() => successPanel.classList.add('is-visible'));
    document.title = 'Registration Successful | Illuminate Verification';
    successPanel.querySelector('#success-title').focus();
  } catch {
    statusMessage.textContent = 'The service is unavailable. Please try again shortly.';
  } finally {
    submitButton.disabled = false;
    submitButton.removeAttribute('aria-busy');
  }
});

getQrCodeButton.addEventListener('click', () => {
  if (!registrationQrDataUrl) {
    return;
  }
  const image = document.createElement('img');
  image.src = registrationQrDataUrl;
  image.alt = `QR code for pass ${qrPassId.textContent}`;
  qrCode.replaceChildren(image);
  qrResult.hidden = false;
  getQrCodeButton.hidden = true;
});

downloadQrButton.addEventListener('click', () => {
  if (!registrationQrDataUrl) {
    return;
  }
  const downloadLink = document.createElement('a');
  downloadLink.href = registrationQrDataUrl;
  downloadLink.download = `${qrPassId.textContent || 'event-pass'}-qr.png`;
  downloadLink.click();
});

function showAdminLogin() {
  adminOverlay.hidden = false;
  registrationPanel.hidden = true;
  document.querySelector('#admin-email').focus();
}

function hideAdminLogin() {
  adminOverlay.hidden = true;
  registrationPanel.hidden = false;
  openAdminLogin.focus();
}

function showDashboard() {
  adminOverlay.hidden = true;
  registrationPanel.hidden = true;
  adminDashboard.hidden = false;
  document.title = 'Admin Dashboard | Illuminate Verification';
  loadRegistrations();
}

function showRegistration() {
  adminDashboard.hidden = true;
  registrationPanel.hidden = false;
  document.title = 'Event Registration';
  openAdminLogin.focus();
}

openAdminLogin.addEventListener('click', showAdminLogin);
closeAdminLogin.addEventListener('click', hideAdminLogin);

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !adminOverlay.hidden) {
    hideAdminLogin();
  }
});

adminLoginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const email = document.querySelector('#admin-email');
  const password = document.querySelector('#admin-password');
  const emailError = document.querySelector('#admin-email-error');
  const passwordError = document.querySelector('#admin-password-error');
  const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value.trim());

  emailError.textContent = validEmail ? '' : 'Enter the provided admin email.';
  passwordError.textContent = password.value ? '' : 'Enter your password.';
  email.setAttribute('aria-invalid', String(!validEmail));
  password.setAttribute('aria-invalid', String(!password.value));
  adminStatus.textContent = '';

  if (!validEmail || !password.value) {
    (validEmail ? password : email).focus();
    return;
  }

  const loginButton = adminLoginForm.querySelector('button[type="submit"]');
  loginButton.disabled = true;
  try {
    const response = await fetch(`${apiBase}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.value, password: password.value })
    });
    const result = await response.json();
    if (!response.ok) {
      adminStatus.textContent = result.error || 'Those admin credentials are not recognized.';
      password.setAttribute('aria-invalid', 'true');
      password.focus();
      return;
    }
    document.querySelector('#admin-name').textContent = result.name;
    adminLoginForm.reset();
    showDashboard();
  } catch {
    adminStatus.textContent = 'The admin service is unavailable. Please try again.';
  } finally {
    loginButton.disabled = false;
  }
});

function createCell(text, className = '') {
  const cell = document.createElement('td');
  cell.textContent = text;
  if (className) {
    cell.className = className;
  }
  return cell;
}

function renderRegistrationDetails(row, detailRow) {
  const detailsCell = document.createElement('td');
  detailsCell.colSpan = 4;
  detailsCell.className = 'registration-detail-cell';
  const detailGrid = document.createElement('div');
  detailGrid.className = 'registration-detail-grid';
  [['Email', row.email], ['Phone', row.phone], ['Illuminate ID', row.illuminateId], ['Pass ID', row.passId], ['Registered', new Date(row.createdAt).toLocaleString()]].forEach(([label, value]) => {
    const item = document.createElement('p');
    const title = document.createElement('strong');
    title.textContent = `${label}: `;
    item.append(title, document.createTextNode(value));
    detailGrid.appendChild(item);
  });
  const qrImage = document.createElement('img');
  qrImage.className = 'admin-qr-image';
  qrImage.src = row.qrDataUrl;
  qrImage.alt = `QR code for ${row.name}`;
  detailGrid.appendChild(qrImage);
  detailsCell.appendChild(detailGrid);
  detailRow.replaceChildren(detailsCell);
}

function renderRegistrations(registrations) {
  registrationsBody.replaceChildren();
  recordCount.textContent = `${registrations.length} ${registrations.length === 1 ? 'record' : 'records'}`;
  if (!registrations.length) {
    const row = document.createElement('tr');
    const cell = createCell('No current registrations.', 'empty-table-message');
    cell.colSpan = 7;
    row.appendChild(cell);
    registrationsBody.appendChild(row);
    return;
  }
  registrations.forEach((registration) => {
    const row = document.createElement('tr');
    row.dataset.registrationId = registration.id;
    const name = document.createElement('strong');
    name.textContent = registration.name;
    const nameCell = document.createElement('td');
    nameCell.appendChild(name);
    const emailCell = createCell(registration.email);
    emailCell.className = 'registration-email';
    const phoneCell = createCell(registration.phone);
    phoneCell.className = 'registration-phone';
    const illuminateIdCell = createCell(registration.illuminateId);
    illuminateIdCell.className = 'registration-code';
    const qrCell = document.createElement('td');
    qrCell.className = 'registration-qr-cell';
    const qrImage = document.createElement('img');
    qrImage.className = 'registration-qr-image';
    qrImage.src = registration.qrDataUrl;
    qrImage.alt = `QR code for ${registration.name}`;
    qrCell.appendChild(qrImage);
    const passCell = createCell(registration.passId);
    passCell.className = 'registration-code';
    row.append(nameCell, emailCell, phoneCell, illuminateIdCell, qrCell, passCell);
    const actionsCell = document.createElement('td');
    actionsCell.className = 'registration-actions';
    const removeButton = document.createElement('button');
    removeButton.className = 'table-action table-action-danger';
    removeButton.type = 'button';
    removeButton.textContent = 'Remove fraud';
    actionsCell.appendChild(removeButton);
    row.appendChild(actionsCell);
    removeButton.addEventListener('click', async () => {
      removeButton.disabled = true;
      removeButton.textContent = 'Removing...';
      const response = await fetch(`${apiBase}/api/admin/registrations/${registration.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Removed by administrator' })
      });
      if (response.ok) {
        loadRegistrations();
      } else {
        const result = await response.json();
        registrationsStatus.textContent = result.error || 'Registration could not be removed.';
        removeButton.disabled = false;
        removeButton.textContent = 'Remove fraud';
      }
    });
    registrationsBody.appendChild(row);
  });
}

async function loadRegistrations() {
  registrationsStatus.textContent = 'Loading registrations...';
  try {
    const response = await fetch(`${apiBase}/api/admin/registrations`);
    const result = await response.json();
    if (response.status === 401) {
      showRegistration();
      showAdminLogin();
      return;
    }
    if (!response.ok) {
      throw new Error(result.error);
    }
    renderRegistrations(result.registrations);
    registrationsStatus.textContent = '';
  } catch (error) {
    registrationsStatus.textContent = error.message || 'Registrations could not be loaded.';
  }
}

async function verifyPass(value) {
  scannerStatus.classList.remove('is-success');
  verificationDetails.hidden = true;
  scannerStatus.textContent = 'Checking pass...';
  const response = await fetch(`${apiBase}/api/admin/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value })
  });
  const result = await response.json();
  scannerStatus.textContent = result.message || 'Pass could not be verified.';
  scannerStatus.classList.toggle('is-success', result.result === 'accepted');
  if (result.attendee) {
    verificationDetails.textContent = `${result.attendee.name} | ${result.attendee.email} | ${result.attendee.illuminateId}`;
    verificationDetails.hidden = false;
  }
}

adminLogout.addEventListener('click', async () => {
  stopCamera();
  await fetch(`${apiBase}/api/admin/logout`, { method: 'POST' });
  showRegistration();
});

verifyPassButton.addEventListener('click', async () => {
  const value = manualPass.value.trim();
  if (!value) {
    scannerStatus.textContent = 'Enter a Pass ID or QR value first.';
    return;
  }
  try {
    await verifyPass(value);
  } catch {
    scannerStatus.textContent = 'The verification service is unavailable.';
  }
});

function stopCamera() {
  scannerLoopActive = false;
  if (scannerStream) {
    scannerStream.getTracks().forEach((track) => track.stop());
    scannerStream = null;
  }
  scannerVideo.hidden = true;
  scannerFrame.hidden = false;
  startCameraButton.textContent = 'Start camera scanner';
}

async function startCamera() {
  if (!('BarcodeDetector' in window) || !navigator.mediaDevices?.getUserMedia) {
    scannerCameraStatus.textContent = 'Camera scanning is not supported here. Use manual Pass ID entry.';
    return;
  }
  try {
    scannerStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    scannerVideo.srcObject = scannerStream;
    await scannerVideo.play();
    scannerVideo.hidden = false;
    scannerFrame.hidden = true;
    scannerLoopActive = true;
    startCameraButton.textContent = 'Stop camera scanner';
    scannerCameraStatus.textContent = 'Camera active. Hold a QR code in view.';
    const detector = new BarcodeDetector({ formats: ['qr_code'] });
    while (scannerLoopActive) {
      const codes = await detector.detect(scannerVideo);
      if (codes[0]?.rawValue) {
        manualPass.value = codes[0].rawValue;
        await verifyPass(codes[0].rawValue);
        stopCamera();
      }
      await new Promise((resolve) => window.setTimeout(resolve, 250));
    }
  } catch {
    stopCamera();
    scannerCameraStatus.textContent = 'Camera access was unavailable. Use manual Pass ID entry.';
  }
}

startCameraButton.addEventListener('click', () => {
  if (scannerStream) {
    stopCamera();
    return;
  }
  startCamera();
});

dashboardTabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    dashboardTabs.forEach((item) => {
      item.classList.toggle('is-active', item === tab);
      item.setAttribute('aria-selected', String(item === tab));
    });
    dashboardViews.forEach((view) => {
      view.hidden = view.id !== tab.getAttribute('aria-controls');
    });
  });
});

