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
const successPanel = document.querySelector('#registration-success');
const successName = document.querySelector('#success-name');
const getQrCodeButton = document.querySelector('#get-qr-code');
const qrResult = document.querySelector('#qr-result');
const qrCode = document.querySelector('#qr-code');
const qrPassId = document.querySelector('#qr-pass-id');
const submitButton = form.querySelector('button[type="submit"]');

let registrationQrDataUrl = '';

const ADMIN_ACCOUNT_LIMIT = 15;
const DEVELOPMENT_ADMIN = {
  email: 'test@example.com',
  password: '28672867',
  name: 'Test Admin'
};

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

  submitButton.disabled = true;
  submitButton.setAttribute('aria-busy', 'true');
  statusMessage.textContent = 'Creating your event pass...';

  try {
    const response = await fetch('/api/events/illuminate-2026/registrations', {
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

adminLoginForm.addEventListener('submit', (event) => {
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

  if (email.value.trim().toLowerCase() !== DEVELOPMENT_ADMIN.email || password.value !== DEVELOPMENT_ADMIN.password) {
    adminStatus.textContent = 'Those admin credentials are not recognized.';
    password.setAttribute('aria-invalid', 'true');
    password.focus();
    return;
  }

  document.querySelector('#admin-name').textContent = DEVELOPMENT_ADMIN.name;
  adminLoginForm.reset();
  showDashboard();
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

adminLogout.addEventListener('click', showRegistration);

verifyPassButton.addEventListener('click', () => {
  const passId = manualPass.value.trim().toUpperCase();
  scannerStatus.textContent = passId === 'ILL-2048' || passId === 'ILL-2054'
    ? `${passId} is verified and ready for entry.`
    : 'Pass not found. Check the ID and try again.';
  scannerStatus.classList.toggle('is-success', passId === 'ILL-2048' || passId === 'ILL-2054');
});
