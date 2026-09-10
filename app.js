const form = document.querySelector('#registration-form');
const statusMessage = document.querySelector('#form-status');
const adminOverlay = document.querySelector('#admin-overlay');
const registrationPanel = document.querySelector('#registration-panel');
const openAdminLogin = document.querySelector('#open-admin-login');
const closeAdminLogin = document.querySelector('#close-admin-login');
const adminLoginForm = document.querySelector('#admin-login-form');
const adminStatus = document.querySelector('#admin-status');

// Replace this client-side placeholder with a server-side allowlist and password verification.
const ADMIN_ACCOUNT_LIMIT = 15;

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

form.addEventListener('submit', (event) => {
  event.preventDefault();
  statusMessage.textContent = '';

  const isValid = Object.values(fields).every(validateField);
  if (!isValid) {
    const firstInvalid = Object.values(fields).find((field) => field.input.getAttribute('aria-invalid') === 'true');
    firstInvalid.input.focus();
    return;
  }

  const submitButton = form.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  submitButton.querySelector('span').textContent = 'Registration submitted';
  statusMessage.textContent = 'Thank you. Your registration has been received.';
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

  adminStatus.textContent = `Admin authentication will connect to the secure backend for ${ADMIN_ACCOUNT_LIMIT} accounts.`;
});
