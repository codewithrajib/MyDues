import { firebaseConfig } from './firebase-config.js';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const firebaseConfigured = Object.values(firebaseConfig).every((value) =>
  typeof value === 'string' && value.length > 0 && !value.startsWith('YOUR_')
);

let firebaseAuth = null;
let firebaseAuthSdk = null;
let activeUnsubscribers = [];
let activePersonUnsubscribers = [];
let authReadyResolved = false;
let signInPromise = null;
const pendingWritesByCollection = new Map();
const pendingPersonDocumentIds = new Set();
let deferredInstallPrompt = window.myDuesInstallPrompt;
let installedThisSession = window.myDuesInstalled === true;

function isInstalledApp() {
  return installedThisSession
    || window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true
    || document.referrer.startsWith('android-app://');
}

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  window.myDuesInstallPrompt = event;
});

window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  installedThisSession = true;
  window.myDuesInstallPrompt = null;
  window.myDuesInstalled = true;
});

function currentMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

const state = {
  people: [],
  dues: [],
  emis: [],
  payments: [],
  user: null,
  month: currentMonth(),
  statementDate: dateString(new Date()),
  activeView: 'overview',
  personId: ''
};

const currency = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 2
});

function money(value) {
  return currency.format(Number(value) || 0);
}

function safeDate(value) {
  if (!value) return null;
  const [year, month, day] = value.split('-').map(Number);
  if (!year || !month || !day) return null;
  return new Date(year, month - 1, day, 12);
}

function dateString(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function monthOf(dateValue) {
  return dateValue ? dateValue.slice(0, 7) : '';
}

function addCalendarMonths(dateValue, count) {
  const date = safeDate(dateValue);
  if (!date) return '';
  const targetMonth = new Date(date.getFullYear(), date.getMonth() + count, 1, 12);
  const day = Math.min(date.getDate(), new Date(targetMonth.getFullYear(), targetMonth.getMonth() + 1, 0).getDate());
  return dateString(new Date(targetMonth.getFullYear(), targetMonth.getMonth(), day, 12));
}

function regularDueMonth(due) {
  if (due.purchaseDate && due.dueDate) return monthOf(due.dueDate);
  return due.monthKey || monthOf(due.purchaseDate || due.dueDate);
}

function regularPurchaseMonth(due) {
  return monthOf(due.purchaseDate || due.dueDate) || due.monthKey || '';
}

function regularVisibleThrough(due) {
  if (due.purchaseDate && due.dueDate) return due.dueDate;
  const monthKey = regularDueMonth(due);
  if (!monthKey) return '';
  const [year, month] = monthKey.split('-').map(Number);
  const lastDay = new Date(year, month, 0).getDate();
  return `${monthKey}-${String(lastDay).padStart(2, '0')}`;
}

function monthLabel(monthKey) {
  const [year, month] = monthKey.split('-').map(Number);
  return new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric' }).format(new Date(year, month - 1, 1));
}

function formatDate(value, options = { day: 'numeric', month: 'short', year: 'numeric' }) {
  const date = safeDate(value);
  return date ? new Intl.DateTimeFormat('en-IN', options).format(date) : '—';
}

function calculateEmi(principal, annualRate, months) {
  const amount = Number(principal);
  const count = Number(months);
  const monthlyRate = Number(annualRate) / 1200;
  if (!amount || !count) return 0;
  if (monthlyRate === 0) return Math.round((amount / count) * 100) / 100;
  const factor = (1 + monthlyRate) ** count;
  return Math.round((amount * monthlyRate * factor / (factor - 1)) * 100) / 100;
}

function alreadyPaidInstallments(plan) {
  const tenure = Number(plan.tenure);
  const alreadyPaid = Math.floor(Number(plan.alreadyPaid) || 0);
  return Math.max(0, Math.min(Number.isFinite(tenure) ? tenure : 0, alreadyPaid));
}

function initials(name = '') {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0] || '').join('').toUpperCase() || '?';
}

function personDocumentIdBase(name = '') {
  let id = name.trim().replace(/[\/\u0000-\u001f\u007f]/g, '-').replace(/\s+/g, ' ');
  if (!id || id === '.' || id === '..' || /^__.*__$/.test(id)) id = `Person - ${id || 'New'}`;
  return id;
}

function uniquePersonDocumentId(name, usedIds) {
  const base = personDocumentIdBase(name);
  let candidate = base;
  let suffix = 2;
  while (usedIds.has(candidate)) {
    candidate = `${base} (${suffix})`;
    suffix += 1;
  }
  usedIds.add(candidate);
  return candidate;
}

function avatarClass(name = '') {
  return `color-${[...name].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 4}`;
}

function monthDifference(first, target) {
  const [firstYear, firstMonth] = first.split('-').map(Number);
  const [targetYear, targetMonth] = target.split('-').map(Number);
  return (targetYear - firstYear) * 12 + targetMonth - firstMonth;
}

function addMonths(monthKey, count) {
  const [year, month] = monthKey.split('-').map(Number);
  const date = new Date(year, month - 1 + count, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function emiFor(plan, monthKey = state.month) {
  const firstDue = safeDate(plan.firstDue);
  if (!firstDue) return null;
  const index = monthDifference(monthOf(plan.firstDue), monthKey);
  const tenure = Number(plan.tenure);
  const alreadyPaid = alreadyPaidInstallments(plan);
  const remainingTenure = tenure - alreadyPaid;
  if (!Number.isFinite(tenure) || tenure <= 0 || index < 0 || index >= remainingTenure) return null;
  const [year, month] = monthKey.split('-').map(Number);
  const day = Math.min(firstDue.getDate(), new Date(year, month, 0).getDate());
  const monthlyEmi = Number(plan.emi) || calculateEmi(plan.principal, plan.rate, tenure);
  const processingFee = index === 0 && alreadyPaid === 0 ? Math.max(0, Number(plan.processingFee) || 0) : 0;
  const amount = monthlyEmi + processingFee;
  return {
    id: `${plan.id}-${monthKey}`,
    planId: plan.id,
    personId: plan.personId,
    type: 'emi',
    category: 'EMI',
    label: plan.provider,
    detail: `Instalment ${alreadyPaid + index + 1} of ${tenure}${processingFee ? ` · includes ${money(processingFee)} processing fee` : ''}`,
    amount,
    monthKey,
    purchaseDate: plan.purchaseDate || '',
    date: dateString(new Date(year, month - 1, day, 12))
  };
}

function chargesFor(personId, monthKey = state.month) {
  const regular = state.dues.filter((due) => {
    if (due.personId !== personId) return false;
    const purchaseMonth = regularPurchaseMonth(due);
    const dueMonth = regularDueMonth(due);
    const visibleThrough = regularVisibleThrough(due);
    const belongsToMonth = purchaseMonth === monthKey || dueMonth === monthKey;
    return belongsToMonth && (!visibleThrough || state.statementDate <= visibleThrough);
  })
    .map((due) => ({
      id: due.id,
      personId,
      type: 'regular',
      category: due.category || 'Other',
      label: due.description || due.category || 'Regular due',
      detail: 'Purchased',
      amount: Number(due.amount) || 0,
      monthKey: regularDueMonth(due),
      purchaseDate: due.purchaseDate || due.dueDate || '',
      dueDate: due.purchaseDate && due.dueDate ? due.dueDate : ''
    }));
  const emiCharges = state.emis.filter((plan) => plan.personId === personId)
    .map((plan) => emiFor(plan, monthKey)).filter((charge) => charge && charge.date >= state.statementDate);
  const charges = [...regular, ...emiCharges].map((charge) => charge.type === 'emi'
    ? { ...charge, dueDate: charge.date }
    : charge);
  return charges.sort((a, b) => (a.dueDate || a.purchaseDate).localeCompare(b.dueDate || b.purchaseDate) || a.label.localeCompare(b.label));
}

function priorChargesTotal(personId, monthKey) {
  const regularTotal = state.dues
    .filter((due) => due.personId === personId && regularDueMonth(due) < monthKey)
    .reduce((sum, due) => sum + Number(due.amount || 0), 0);
  const emiTotal = state.emis.filter((plan) => plan.personId === personId).reduce((sum, plan) => {
    const firstMonth = monthOf(plan.firstDue);
    const tenure = Number(plan.tenure);
    if (!safeDate(plan.firstDue) || !Number.isFinite(tenure) || tenure <= 0) return sum;
    const alreadyPaid = alreadyPaidInstallments(plan);
    const remainingTenure = tenure - alreadyPaid;
    const instalments = Math.min(
      Math.max(0, monthDifference(firstMonth, addMonths(monthKey, -1)) + 1),
      remainingTenure
    );
    if (!instalments) return sum;
    const monthlyEmi = Number(plan.emi) || calculateEmi(plan.principal, plan.rate, plan.tenure);
    const processingFee = alreadyPaid === 0 ? Math.max(0, Number(plan.processingFee) || 0) : 0;
    return sum + monthlyEmi * instalments + processingFee;
  }, 0);
  return regularTotal + emiTotal;
}

function accountFor(personId, monthKey = state.month) {
  const currentCharges = chargesFor(personId, monthKey);
  const currentPayments = state.payments.filter((payment) => payment.personId === personId && payment.monthKey === monthKey);
  const regularBilled = state.dues
    .filter((due) => due.personId === personId && regularDueMonth(due) === monthKey)
    .reduce((sum, due) => sum + Number(due.amount || 0), 0);
  const emiBilled = state.emis.filter((plan) => plan.personId === personId)
    .map((plan) => emiFor(plan, monthKey))
    .filter(Boolean)
    .reduce((sum, charge) => sum + charge.amount, 0);
  const billed = regularBilled + emiBilled;
  const paid = currentPayments.reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
  const opening = priorChargesTotal(personId, monthKey)
    - state.payments.filter((payment) => payment.personId === personId && payment.monthKey < monthKey)
      .reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
  return {
    currentCharges,
    currentPayments,
    billed,
    paid,
    opening,
    balance: opening + billed - paid
  };
}

function accountBalance(personId, monthKey = state.month) {
  return accountFor(personId, monthKey).balance;
}

function setStatus(label, status = 'signed-out') {
  $('#syncLabel').textContent = label;
  $('#syncDot').className = `sync-dot${['cloud', 'pending', 'offline', 'error'].includes(status) ? ` ${status}` : ''}`;
  const labels = {
    cloud: 'Cloud sync active',
    pending: 'Changes waiting to sync',
    offline: 'Offline changes saved on this device',
    error: 'Cloud sync error'
  };
  $('#syncDot').setAttribute('aria-label', labels[status] || 'Sign-in required');
}

function updateSyncStatus() {
  if (!isGoogleAccount(state.user)) return;
  if (!navigator.onLine) {
    setStatus('Offline · saved on device', 'offline');
  } else if ([...pendingWritesByCollection.values()].some(Boolean)) {
    setStatus('Syncing changes…', 'pending');
  } else {
    setStatus('Cloud sync on', 'cloud');
  }
}

let toastTimer;
function showToast(message, isError = false) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.toggle('error-toast', isError);
  toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 3200);
}

function isGoogleAccount(user) {
  return Boolean(user?.providerData?.some((provider) => provider.providerId === 'google.com'));
}

function renderProfileAvatar(element, user, fallback) {
  const photoURL = user?.photoURL
    || user?.providerData?.find((provider) => provider.providerId === 'google.com')?.photoURL;
  if (!photoURL) {
    element.textContent = fallback;
    element.classList.remove('has-photo');
    return;
  }
  const image = document.createElement('img');
  image.alt = '';
  image.decoding = 'async';
  image.addEventListener('error', () => {
    if (element.firstElementChild !== image) return;
    element.textContent = fallback;
    element.classList.remove('has-photo');
  }, { once: true });
  image.src = photoURL;
  element.replaceChildren(image);
  element.classList.add('has-photo');
}

function renderAccountControl(user) {
  const signedIn = isGoogleAccount(user);
  const name = signedIn ? user.displayName || user.email || 'Google account' : 'Sign in';
  const email = signedIn ? user.email || '' : 'Google to save records';
  $('#accountName').textContent = name;
  $('#accountEmail').textContent = email;
  renderProfileAvatar($('#accountAvatar'), signedIn ? user : null, signedIn ? initials(name) : 'G');
  renderProfileAvatar($('.user-avatar'), signedIn ? user : null, 'M');
  $('#accountTrigger').title = signedIn ? email : 'Sign in with Google to record data';
  $('#accountTrigger').setAttribute('aria-label', signedIn ? `Account menu for ${name}` : 'Sign in with Google');
  $('#signOutButton').hidden = !signedIn;
  $('#accountMenu').hidden = true;
  $('#accountTrigger').setAttribute('aria-expanded', 'false');
}

function showStartupGate() {
  const gate = $('#startupGate');
  if (!gate.open) gate.showModal();
}

function showStartupGateError(message) {
  showStartupGate();
  const error = $('#startupGateError');
  error.textContent = message;
  error.hidden = false;
}

function hideStartupGate() {
  const gate = $('#startupGate');
  if (gate.open) gate.close();
}

function markAuthReady() {
  authReadyResolved = true;
}

async function ensureGoogleSignIn() {
  if (!firebaseConfigured) {
    showStartupGateError('Firebase must be configured before you can sign in.');
    return false;
  }
  if (!authReadyResolved) {
    showStartupGateError('Google sign-in is still connecting. Please try again shortly.');
    return false;
  }
  if (!firebaseAuth || !firebaseAuthSdk) {
    showStartupGateError('Firebase Authentication is unavailable. Check your Firebase setup.');
    return false;
  }
  if (isGoogleAccount(firebaseAuth.currentUser)) return true;
  if (signInPromise) return signInPromise;

  signInPromise = (async () => {
    try {
      const provider = new firebaseAuthSdk.GoogleAuthProvider();
      if (firebaseAuth.currentUser) {
        await firebaseAuthSdk.linkWithPopup(firebaseAuth.currentUser, provider);
      } else {
        await firebaseAuthSdk.signInWithPopup(firebaseAuth, provider);
      }
      return true;
    } catch (error) {
      console.error(error);
      if (error.code === 'auth/popup-closed-by-user') {
        showStartupGateError('Sign-in was canceled. Select Continue with Google to try again.');
      } else if (error.code === 'auth/popup-blocked') {
        showStartupGateError('The sign-in popup was blocked. Allow popups for this site and try again.');
      } else if (error.code === 'auth/credential-already-in-use') {
        showStartupGateError('This Google account is already linked elsewhere. Try the Google account that owns these records.');
      } else {
        showStartupGateError(`Google sign-in failed: ${error.message || 'Check your connection and try again.'}`);
      }
      return false;
    }
  })();
  try {
    return await signInPromise;
  } finally {
    signInPromise = null;
  }
}

async function showFormAfterSignIn(formId, personId = '', record = null) {
  if (await ensureGoogleSignIn()) showForm(formId, personId, record);
}

function personFor(personId) {
  return state.people.find((person) => person.id === personId);
}

function emiPlanSummary(plan, monthKey = state.month) {
  const firstMonth = monthOf(plan.firstDue);
  const index = monthDifference(firstMonth, monthKey);
  const tenure = Number(plan.tenure);
  if (!safeDate(plan.firstDue) || !Number.isFinite(index) || !Number.isFinite(tenure) || tenure <= 0) {
    return { monthlyEmi: 0, processingFee: 0, remainingCount: 0, remainingAmount: 0 };
  }
  const alreadyPaid = alreadyPaidInstallments(plan);
  const monthlyEmi = Number(plan.emi) || calculateEmi(plan.principal, plan.rate, tenure);
  const remainingTenure = tenure - alreadyPaid;
  const currentInstallment = index >= 0 ? emiFor(plan, monthKey) : null;
  const dueInstallmentCount = currentInstallment && currentInstallment.date <= state.statementDate ? 1 : 0;
  const elapsedRemainingIndex = Math.max(0, index) + dueInstallmentCount;
  const remainingCount = Math.max(0, remainingTenure - elapsedRemainingIndex);
  const processingFee = remainingCount && alreadyPaid === 0 && index <= 0
    ? Math.max(0, Number(plan.processingFee) || 0)
    : 0;
  return {
    monthlyEmi,
    processingFee,
    remainingCount,
    remainingAmount: monthlyEmi * remainingCount + processingFee
  };
}

function emiPlansFor(personId, monthKey = state.month) {
  return state.emis.filter((plan) => plan.personId === personId)
    .map((plan) => ({ plan, summary: emiPlanSummary(plan, monthKey) }))
    .sort((a, b) => Number(a.summary.remainingCount === 0) - Number(b.summary.remainingCount === 0));
}

function emiRemainingFor(personId, monthKey = state.month) {
  return emiPlansFor(personId, monthKey).reduce((sum, entry) => sum + entry.summary.remainingAmount, 0);
}

function recordActionButtons(recordId, editAction, deleteAction) {
  const actions = document.createElement('div');
  actions.className = 'record-actions';
  for (const [action, label] of [[editAction, 'Edit'], [deleteAction, 'Delete']]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'row-action';
    if (action.startsWith('delete-')) button.classList.add('row-action-danger');
    button.dataset.action = action;
    button.dataset.recordId = recordId;
    button.textContent = label;
    actions.append(button);
  }
  return actions;
}

function emiPlanCard(plan, summary) {
  const card = document.createElement('article');
  card.className = 'emi-plan-card';
  const completed = summary.remainingCount === 0;
  card.classList.toggle('is-completed', completed);
  card.innerHTML = `
    <div class="emi-plan-top"><span class="emi-plan-icon" aria-hidden="true">EMI</span><span class="emi-plan-title"></span><span class="emi-plan-status"></span></div>
    <div class="emi-plan-details"><span><small>Purchase amount</small><strong class="emi-principal"></strong></span><span><small>Monthly instalment</small><strong class="emi-monthly"></strong></span><span><small>Instalments left</small><strong class="emi-count"></strong></span></div>
    <div class="emi-plan-total"><span></span><strong class="emi-total"></strong></div>
    <small class="emi-plan-note"></small>`;
  card.querySelector('.emi-plan-title').textContent = plan.provider || 'EMI plan';
  card.querySelector('.emi-plan-status').textContent = completed ? 'Completed' : `${summary.remainingCount} left`;
  card.querySelector('.emi-plan-status').classList.toggle('completed', completed);
  card.querySelector('.emi-principal').textContent = money(plan.principal);
  card.querySelector('.emi-monthly').textContent = money(summary.monthlyEmi);
  card.querySelector('.emi-count').textContent = String(summary.remainingCount);
  card.querySelector('.emi-plan-total span').textContent = completed ? 'Remaining' : 'Scheduled amount left';
  card.querySelector('.emi-total').textContent = money(summary.remainingAmount);
  card.querySelector('.emi-plan-note').textContent = completed
    ? 'All scheduled instalments are complete'
    : summary.processingFee
      ? `Includes ${money(summary.processingFee)} processing fee in the first instalment`
      : `Schedule after ${formatDate(state.statementDate)}; due instalments stay listed through their date`;
  card.append(recordActionButtons(plan.id, 'edit-emi', 'delete-emi'));
  return card;
}

function setView(view) {
  state.activeView = view;
  $$('.view-panel').forEach((panel) => { panel.hidden = panel.id !== `view-${view}`; });
  $$('.nav-link').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
  $('.sidebar').classList.remove('open');
  render();
}

function personCard(person) {
  const account = accountFor(person.id);
  const emiPlans = emiPlansFor(person.id);
  const card = document.createElement('article');
  card.className = 'person-card';
  card.innerHTML = `
    <div class="person-card-top">
      <span class="person-avatar ${avatarClass(person.name)}"></span>
      <span class="person-card-identity"><strong></strong><small></small></span>
      <button class="card-open" type="button" data-action="open-person">Open account →</button>
    </div>
    <div class="person-card-metrics">
      <span class="person-metric"><small>Due this month</small><strong class="metric-due"></strong></span>
      <span class="person-metric"><small>Repaid</small><strong class="metric-paid"></strong></span>
      <span class="person-metric emi-metric" hidden><small>EMI scheduled left</small><strong class="metric-emi"></strong></span>
      <span class="person-metric balance"><small>Net balance</small><strong class="metric-balance"></strong></span>
    </div>
    <div class="person-emi-list"></div>
    <div class="person-card-actions">
      <button type="button" data-action="add-due">+ Regular due</button>
      <button type="button" data-action="add-emi">+ EMI plan</button>
      <button type="button" data-action="add-payment">Record repayment</button>
      <button type="button" data-action="person-statement">PDF statement</button>
    </div>`;
  card.dataset.personId = person.id;
  card.querySelector('.person-avatar').textContent = initials(person.name);
  card.querySelector('.person-card-identity strong').textContent = person.name;
  card.querySelector('.person-card-identity small').textContent = person.phone || 'Personal account';
  card.querySelector('.metric-due').textContent = money(account.billed);
  card.querySelector('.metric-paid').textContent = money(account.paid);
  card.querySelector('.metric-emi').textContent = money(emiPlans.reduce((sum, entry) => sum + entry.summary.remainingAmount, 0));
  card.querySelector('.emi-metric').hidden = emiPlans.length === 0;
  card.querySelector('.person-card-metrics').classList.toggle('has-emis', emiPlans.length > 0);
  card.querySelector('.metric-balance').textContent = account.balance < -0.01 ? `${money(Math.abs(account.balance))} credit` : money(Math.max(0, account.balance));
  const planList = card.querySelector('.person-emi-list');
  planList.hidden = emiPlans.length === 0;
  for (const { plan, summary } of emiPlans) {
    const item = document.createElement('div');
    item.className = 'person-emi-item';
    item.classList.toggle('completed', summary.remainingCount === 0);
    const name = document.createElement('strong');
    name.textContent = plan.provider || 'EMI plan';
    const detail = document.createElement('span');
    detail.textContent = summary.remainingCount
      ? `${money(summary.monthlyEmi)}/mo · ${summary.remainingCount} instalments · ${money(summary.remainingAmount)} left`
      : 'Completed';
    item.append(name, detail);
    planList.append(item);
  }
  return card;
}

function renderOverview() {
  const people = state.people;
  $('#allStatementButton').title = people.length ? '' : 'Add a person before creating a ledger statement.';
  let billed = 0;
  let collected = 0;
  let balance = 0;
  for (const person of people) {
    const account = accountFor(person.id);
    billed += account.billed;
    collected += account.paid;
    balance += Math.max(0, account.balance);
  }
  const activeEmis = state.emis.filter((plan) => {
    const charge = emiFor(plan, state.month);
    return charge && charge.date >= state.statementDate;
  }).length;
  $('#billedTotal').textContent = money(billed);
  $('#billedNote').textContent = `${state.dues.filter((due) => regularDueMonth(due) === state.month).length} regular dues + EMI instalments`;
  $('#collectedTotal').textContent = money(collected);
  $('#collectionNote').textContent = `Received from ${new Set(state.payments.filter((payment) => payment.monthKey === state.month).map((payment) => payment.personId)).size} people`;
  $('#collectionProgress').style.width = `${billed ? Math.min(100, collected / billed * 100) : 0}%`;
  $('#balanceTotal').textContent = money(balance);
  $('#balanceNote').textContent = `Across ${people.length} ${people.length === 1 ? 'person' : 'people'}`;
  $('#emiCount').textContent = String(activeEmis);
  $('#emiNote').textContent = `${activeEmis} scheduled this month`;
  $('#peopleCount').textContent = String(people.length);
  $('#overviewPeople').replaceChildren(...people.map(personCard));
  $('#overviewPeopleEmpty').hidden = people.length > 0;
  renderRecent($('#recentPayments'), state.payments.filter((payment) => payment.monthKey === state.month).slice().sort((a, b) => b.paidDate.localeCompare(a.paidDate)).slice(0, 5));
}

function renderPeople() {
  const people = [...state.people].sort((a, b) => a.name.localeCompare(b.name));
  $('#peopleGrid').replaceChildren(...people.map(personCard));
  $('#peopleEmpty').hidden = people.length > 0;
}

function renderPerson() {
  const person = personFor(state.personId);
  if (!person) {
    $('#personNameHeading').textContent = 'Person';
    $('#personContact').textContent = '';
    $('#accountTableBody').replaceChildren();
    $('#accountEmpty').hidden = false;
    return;
  }
  const account = accountFor(person.id);
  $('#personAvatar').textContent = initials(person.name);
  $('#personAvatar').className = `person-avatar person-avatar-large ${avatarClass(person.name)}`;
  $('#personNameHeading').textContent = person.name;
  $('#personContact').textContent = person.phone || 'Personal account';
  $('#openingBalance').textContent = money(account.opening);
  $('#personBilled').textContent = money(account.billed);
  $('#personPaid').textContent = money(account.paid);
  $('#personBalance').textContent = account.balance < -0.01 ? `${money(Math.abs(account.balance))} credit` : money(Math.max(0, account.balance));
  $('#personBalanceNote').textContent = account.balance < -0.01 ? 'Credit remaining on account' : `Net balance for ${monthLabel(state.month)}`;
  $('#personMonthLabel').textContent = monthLabel(state.month);
  const emiPlans = emiPlansFor(person.id);
  $('.person-stats').classList.toggle('has-emis', emiPlans.length > 0);
  $('.person-stats .emi-stat').hidden = emiPlans.length === 0;
  const remainingEmis = emiPlans.filter((entry) => entry.summary.remainingCount > 0);
  const emiRemaining = remainingEmis.reduce((sum, entry) => sum + entry.summary.remainingAmount, 0);
  $('#personEmiRemaining').textContent = money(emiRemaining);
  $('#personEmiRemainingNote').textContent = remainingEmis.length
    ? `${remainingEmis.reduce((sum, entry) => sum + entry.summary.remainingCount, 0)} instalments across ${remainingEmis.length} ${remainingEmis.length === 1 ? 'plan' : 'plans'}`
    : 'No scheduled instalments left';
  $('#emiPlansSubtitle').textContent = `Remaining schedule from ${monthLabel(state.month)}; prior unpaid amounts stay in net balance.`;
  $('#personEmiPlans').replaceChildren(...emiPlans.map(({ plan, summary }) => emiPlanCard(plan, summary)));
  $('#personEmiPlansEmpty').hidden = emiPlans.length > 0;

  const tbody = $('#accountTableBody');
  tbody.replaceChildren();
  for (const charge of account.currentCharges) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><span class="type-label ${charge.type === 'emi' ? 'type-emi' : ''}"></span></td><td class="charge-label"></td><td></td><td></td><td class="amount-cell"></td><td class="charge-detail"></td><td class="table-actions"></td>`;
    tr.querySelector('.type-label').textContent = charge.type === 'emi' ? 'EMI' : charge.category;
    tr.querySelector('.charge-label').textContent = charge.label;
    tr.children[2].textContent = formatDate(charge.purchaseDate);
    tr.children[3].textContent = formatDate(charge.dueDate);
    tr.children[4].textContent = money(charge.amount);
    tr.querySelector('.charge-detail').textContent = charge.detail;
    if (charge.type === 'regular') {
      tr.children[6].append(recordActionButtons(charge.id, 'edit-due', 'delete-due'));
    }
    tbody.append(tr);
  }
  $('#accountEmpty').hidden = account.currentCharges.length > 0;
  tbody.closest('.table-wrap').classList.toggle('has-empty', account.currentCharges.length === 0);
  $('#personPaymentSubtitle').textContent = `Repayments recorded for ${monthLabel(state.month)}`;
  renderRecent($('#personPayments'), account.currentPayments.slice().sort((a, b) => b.paidDate.localeCompare(a.paidDate)));
}

function renderRecent(container, payments) {
  container.replaceChildren();
  if (!payments.length) {
    const empty = document.createElement('p');
    empty.className = 'recent-empty';
    empty.textContent = 'No repayments recorded for this month yet.';
    container.append(empty);
    return;
  }
  for (const payment of payments) {
    const person = personFor(payment.personId);
    const row = document.createElement('div');
    row.className = 'recent-row';
    row.innerHTML = `<span class="person-avatar ${avatarClass(person?.name)}"></span><span class="recent-main"><strong></strong><small></small></span><span class="recent-amount"></span>`;
    row.querySelector('.person-avatar').textContent = initials(person?.name || 'Unknown');
    row.querySelector('.recent-main strong').textContent = person?.name || 'Unknown person';
    row.querySelector('.recent-main small').textContent = `${formatDate(payment.paidDate)} · ${payment.note || 'Repayment'} · ${monthLabel(payment.monthKey)}`;
    row.querySelector('.recent-amount').textContent = `+${money(payment.amount)}`;
    row.append(recordActionButtons(payment.id, 'edit-payment', 'delete-payment'));
    container.append(row);
  }
}

function renderRepayments() {
  const payments = state.payments.filter((payment) => payment.monthKey === state.month)
    .sort((a, b) => b.paidDate.localeCompare(a.paidDate));
  const tbody = $('#repaymentsTableBody');
  tbody.replaceChildren();
  for (const payment of payments) {
    const person = personFor(payment.personId);
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><div class="person-cell"><span class="person-avatar ${avatarClass(person?.name)}"></span><span class="person-detail"><strong></strong><small></small></span></div></td><td></td><td></td><td class="amount-cell"></td><td></td><td class="table-actions"></td>`;
    tr.querySelector('.person-avatar').textContent = initials(person?.name || 'Unknown');
    tr.querySelector('.person-detail strong').textContent = person?.name || 'Unknown person';
    tr.querySelector('.person-detail small').textContent = person?.phone || 'Personal account';
    tr.children[1].textContent = formatDate(payment.paidDate);
    tr.children[2].textContent = monthLabel(payment.monthKey);
    tr.children[3].textContent = money(payment.amount);
    tr.children[4].textContent = payment.note || '—';
    tr.children[5].append(recordActionButtons(payment.id, 'edit-payment', 'delete-payment'));
    tbody.append(tr);
  }
  $('#repaymentHeadingCount').textContent = String(payments.length);
  $('#repaymentMonthLabel').textContent = monthLabel(state.month);
  $('#repaymentsPeriodTotal').textContent = `${money(payments.reduce((sum, payment) => sum + Number(payment.amount || 0), 0))} received`;
  $('#repaymentsEmpty').hidden = payments.length > 0;
  tbody.closest('.table-wrap').classList.toggle('has-empty', payments.length === 0);
}

function render() {
  $('#statementDatePicker').value = state.statementDate;
  renderOverview();
  renderPeople();
  renderPerson();
  renderRepayments();
}

function showForm(formId, personId = '', record = null) {
  $$('.dialog-form').forEach((form) => { form.hidden = form.id !== formId; });
  const form = $(`#${formId}`);
  form.reset();
  form.dataset.recordId = record?.id || '';
  $$('.dialog-error').forEach((error) => { error.textContent = ''; });
  const selectedPerson = record?.personId || personId || state.personId || state.people[0]?.id || '';
  if (formId === 'dueForm') {
    fillPersonSelect($('#duePerson'), selectedPerson);
    const purchaseDate = record?.purchaseDate || record?.dueDate || dateString(new Date());
    $('#dueForm').elements.purchaseDate.value = purchaseDate;
    $('#dueForm').elements.dueDate.value = record?.purchaseDate
      ? record.dueDate || addCalendarMonths(purchaseDate, 1)
      : addCalendarMonths(purchaseDate, 1);
    $('#dueForm').dataset.suggestedDueDate = $('#dueForm').elements.dueDate.value;
    $('#dueForm').elements.category.value = record?.category || 'Grocery';
    $('#dueForm').elements.amount.value = record?.amount ?? '';
    $('#dueForm').elements.description.value = record?.description || '';
    $('#dueForm h2').textContent = record ? 'Edit a regular due' : 'Add a regular due';
    $('#dueForm .dialog-description').textContent = record
      ? 'Update when this regular charge was purchased and when it is due.'
      : 'Record the purchase date and the date this charge is due.';
    $('#dueForm .dialog-kicker').textContent = record ? 'UPDATE ACCOUNT' : 'MONTHLY ACCOUNT';
    $('#dueForm .dialog-submit').innerHTML = record ? 'Save changes <span>→</span>' : 'Add to account <span>→</span>';
  }
  if (formId === 'emiForm') {
    fillPersonSelect($('#emiPerson'), selectedPerson);
    const today = new Date();
    $('#emiForm').elements.purchaseDate.value = record?.purchaseDate || (record ? '' : dateString(today));
    $('#emiForm').elements.purchaseDate.required = !record || Boolean(record.purchaseDate);
    $('#emiForm').elements.firstDue.value = dateString(new Date(today.getFullYear(), today.getMonth() + 1, 5));
    if (record) {
      $('#emiForm').elements.provider.value = record.provider || '';
      $('#emiForm').elements.principal.value = record.principal ?? '';
      $('#emiForm').elements.rate.value = record.rate ?? 0;
      $('#emiForm').elements.processingFee.value = record.processingFee ?? 0;
      $('#emiForm').elements.tenure.value = record.tenure ?? '';
      $('#emiForm').elements.alreadyPaid.value = record.alreadyPaid ?? 0;
      $('#emiForm').elements.firstDue.value = record.firstDue || '';
    }
    $('#emiForm h2').textContent = record ? 'Edit EMI plan' : 'Add an EMI plan';
    $('#emiForm .dialog-description').textContent = record
      ? 'Update this purchase and its scheduled monthly instalments.'
      : 'Enter any instalments already paid; they will not be added to this account.';
    $('#emiForm .dialog-kicker').textContent = record ? 'UPDATE EMI PLAN' : 'SCHEDULED INSTALLMENT';
    $('#emiForm .dialog-submit').innerHTML = record ? 'Save changes <span>→</span>' : 'Save EMI plan <span>→</span>';
    updateEmiPreview();
  }
  if (formId === 'paymentForm') {
    fillPersonSelect($('#paymentPerson'), selectedPerson);
    $('#paymentDate').value = record?.paidDate || dateString(new Date());
    $('#paymentAmount').value = record?.amount ?? '';
    $('#paymentForm').elements.note.value = record?.note || '';
    $('#paymentForMonth').textContent = monthLabel(record?.monthKey || state.month);
    $('#paymentForm h2').textContent = record ? 'Edit repayment' : 'Record a repayment';
    $('#paymentForm .dialog-description').textContent = record
      ? 'Update the repayment details. Its applied account month will stay the same.'
      : "This reduces the person's running net balance.";
    $('#paymentForm .dialog-kicker').textContent = record ? 'UPDATE REPAYMENT' : 'PAYMENT RECEIVED';
    $('#paymentForm .dialog-submit').innerHTML = record ? 'Save changes <span>→</span>' : 'Save repayment <span>→</span>';
  }
  $('#formDialog').showModal();
  form.querySelector('input:not([type="hidden"]), select')?.focus();
}

function fillPersonSelect(select, selectedId) {
  select.replaceChildren(...state.people.map((person) => {
    const option = document.createElement('option');
    option.value = person.id;
    option.textContent = person.name;
    return option;
  }));
  if (selectedId) select.value = selectedId;
}

async function addPerson(data) {
  if (!data.name.trim()) throw new Error("Enter the person's name.");
  const person = {
    id: uniquePersonDocumentId(data.name.trim(), new Set([
      ...state.people.map((entry) => entry.id),
      ...pendingPersonDocumentIds
    ])),
    name: data.name.trim(),
    phone: data.phone.trim(),
    createdAt: new Date().toISOString()
  };
  pendingPersonDocumentIds.add(person.id);
  try {
    return await persistRecord('people', person);
  } catch (error) {
    pendingPersonDocumentIds.delete(person.id);
    throw error;
  }
}

function addRegularDue(data, recordId = '') {
  const amount = Number(data.amount);
  if (!data.personId || !amount || amount <= 0 || !safeDate(data.purchaseDate) || !safeDate(data.dueDate)) {
    throw new Error('Choose a person and enter a valid amount, purchase date, and due date.');
  }
  const existing = recordId ? state.dues.find((entry) => entry.id === recordId) : null;
  if (recordId && !existing) throw new Error('This regular due is no longer available.');
  const due = {
    id: existing?.id || crypto.randomUUID(),
    personId: data.personId,
    category: data.category,
    description: data.description.trim() || data.category,
    amount,
    purchaseDate: data.purchaseDate,
    dueDate: data.dueDate,
    monthKey: monthOf(data.dueDate),
    createdAt: existing?.createdAt || new Date().toISOString()
  };
  return persistRecord('dues', due, Boolean(existing), existing);
}

function addEmi(data, recordId = '') {
  const principal = Number(data.principal);
  const rate = Number(data.rate);
  const processingFee = Number(data.processingFee);
  const tenure = Number(data.tenure);
  const alreadyPaid = Number(data.alreadyPaid) || 0;
  const existing = recordId ? state.emis.find((entry) => entry.id === recordId) : null;
  const purchaseDate = data.purchaseDate || existing?.purchaseDate || '';
  if (recordId && !existing) throw new Error('This EMI plan is no longer available.');
  if (!data.personId || !data.provider.trim() || principal <= 0 || !Number.isFinite(rate) || rate < 0
    || !Number.isFinite(processingFee) || processingFee < 0 || !Number.isInteger(tenure) || tenure <= 0
    || !Number.isInteger(alreadyPaid) || alreadyPaid < 0 || alreadyPaid > tenure
    || (!existing && !safeDate(purchaseDate)) || (purchaseDate && !safeDate(purchaseDate)) || !safeDate(data.firstDue)) {
    throw new Error('Enter valid EMI details, including the purchase and first due dates, and ensure the already-given count is between zero and the total term.');
  }
  const emi = {
    id: existing?.id || crypto.randomUUID(),
    personId: data.personId,
    provider: data.provider.trim(),
    principal,
    rate,
    processingFee,
    tenure,
    alreadyPaid,
    firstDue: data.firstDue,
    createdAt: existing?.createdAt || new Date().toISOString()
  };
  if (purchaseDate) emi.purchaseDate = purchaseDate;
  emi.emi = calculateEmi(emi.principal, emi.rate, emi.tenure);
  return persistRecord('emis', emi, Boolean(existing), existing);
}

function updateEmiPreview() {
  const form = $('#emiForm');
  const monthlyEmi = calculateEmi(form.elements.principal.value, form.elements.rate.value, form.elements.tenure.value);
  const processingFee = Math.max(0, Number(form.elements.processingFee.value) || 0);
  const alreadyPaid = Math.max(0, Number(form.elements.alreadyPaid.value) || 0);
  const tenure = Number(form.elements.tenure.value);
  if (Number.isFinite(tenure) && tenure > 0 && alreadyPaid >= tenure) {
    $('#emiPreviewLabel').textContent = 'No scheduled EMIs remain';
    $('#emiPreview').textContent = '—';
    return;
  }
  $('#emiPreviewLabel').textContent = 'Next scheduled EMI';
  $('#emiPreview').textContent = money(monthlyEmi + (alreadyPaid === 0 ? processingFee : 0));
}

function addRepayment(data, recordId = '') {
  const amount = Number(data.amount);
  if (!data.personId || !amount || amount <= 0 || !data.paidDate) throw new Error('Choose a person and enter a valid repayment amount and date.');
  const existing = recordId ? state.payments.find((entry) => entry.id === recordId) : null;
  if (recordId && !existing) throw new Error('This repayment is no longer available.');
  const payment = {
    id: existing?.id || crypto.randomUUID(),
    personId: data.personId,
    amount,
    paidDate: data.paidDate,
    monthKey: existing?.monthKey || state.month,
    note: data.note.trim(),
    createdAt: existing?.createdAt || new Date().toISOString()
  };
  return persistRecord('payments', payment, Boolean(existing), existing);
}

function persistRecord(collection, record, isEdit = false, previousRecord = null) {
  if (!firebaseConfigured) throw new Error('Firebase must be configured before records can be saved.');
  if (!isGoogleAccount(firebaseAuth?.currentUser) || !window.myDuesStore) {
    throw new Error('Sign in with Google before saving records.');
  }
  return isEdit
    ? window.myDuesStore.update(collection, record, previousRecord)
    : window.myDuesStore.add(collection, record);
}

function showToastForSave(recordName, wasUpdated = false) {
  const verb = wasUpdated ? 'updated' : 'saved';
  showToast(navigator.onLine
    ? `${recordName} ${verb}. Syncing with Firestore.`
    : `${recordName} ${verb} on this device. It will sync when you're back online.`);
}

function showToastForDelete(recordName) {
  showToast(navigator.onLine
    ? `${recordName} deleted. Syncing with Firestore.`
    : `${recordName} deleted on this device. The change will sync when you're back online.`);
}

function statementMarkup(title, subtitle, summary, rows, payments = [], person = null) {
  const print = $('#statementPrint');
  print.replaceChildren();
  print.className = person ? 'statement statement-person' : 'statement statement-summary';

  const brandRow = document.createElement('div');
  brandRow.className = 'statement-brand-row';
  brandRow.innerHTML = '<strong class="statement-brand">mydues<span>.</span></strong>';
  const period = document.createElement('span');
  period.className = 'statement-period';
  period.textContent = monthLabel(state.month);
  brandRow.append(period);
  const titleRow = document.createElement('div');
  titleRow.className = 'statement-title-row';
  const titleGroup = document.createElement('div');
  const eyebrow = document.createElement('p');
  eyebrow.className = 'statement-eyebrow';
  eyebrow.textContent = person ? 'PERSONAL ACCOUNT STATEMENT' : 'ACCOUNT SUMMARY';
  const heading = document.createElement('h1');
  heading.textContent = title;
  const sub = document.createElement('p');
  sub.className = 'statement-subtitle';
  sub.textContent = subtitle;
  titleGroup.append(eyebrow, heading, sub);
  titleRow.append(titleGroup);

  if (person) {
    const identity = document.createElement('div');
    identity.className = 'statement-person-identity';
    const avatar = document.createElement('span');
    avatar.className = 'statement-avatar';
    avatar.textContent = initials(person.name);
    const identityText = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = person.name;
    const contact = document.createElement('span');
    contact.textContent = person.phone || 'Personal account';
    identityText.append(name, contact);
    identity.append(avatar, identityText);
    titleRow.append(identity);
  }

  const summaryGrid = document.createElement('div');
  summaryGrid.className = 'statement-summary-grid';
  const summaryValues = [
    ['Balance brought forward', summary.opening],
    ['New dues this month', summary.billed],
    ['Repayments received', summary.paid],
    ['Net balance', summary.balance]
  ];
  for (const [label, value] of summaryValues) {
    const metric = document.createElement('div');
    metric.className = `statement-summary-card${label === 'Net balance' ? ' statement-summary-balance' : ''}`;
    const metricLabel = document.createElement('span');
    metricLabel.textContent = label;
    const metricValue = document.createElement('strong');
    metricValue.textContent = value;
    metric.append(metricLabel, metricValue);
    summaryGrid.append(metric);
  }

  const chargesSection = document.createElement('section');
  chargesSection.className = 'statement-section';
  const chargesHeading = document.createElement('div');
  chargesHeading.className = 'statement-section-heading';
  chargesHeading.innerHTML = '<h2>Monthly account activity</h2><p>Purchases and EMI instalments for the statement month</p>';
  const table = document.createElement('table');
  table.className = 'statement-table';
  table.innerHTML = '<thead><tr><th>TYPE</th><th>ITEM / PROVIDER</th><th>PURCHASE DATE</th><th>DUE DATE</th><th>AMOUNT</th><th>DETAIL</th></tr></thead><tbody></tbody><tfoot><tr><th colspan="4">Total</th><th class="statement-total-amount"></th><th></th></tr></tfoot>';
  const tbody = table.querySelector('tbody');
  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.className = row.type === 'emi' ? 'statement-charge-emi' : 'statement-charge-regular';
    for (const value of [row.type === 'emi' ? 'EMI' : row.category, row.label, formatDate(row.purchaseDate), formatDate(row.dueDate), money(row.amount), row.detail]) {
      const cell = document.createElement('td');
      cell.textContent = value;
      tr.append(cell);
    }
    tbody.append(tr);
  }
  if (!rows.length) {
    const emptyRow = document.createElement('tr');
    const emptyCell = document.createElement('td');
    emptyCell.colSpan = 6;
    emptyCell.textContent = 'No purchases or EMI instalments recorded for this month.';
    emptyRow.append(emptyCell);
    tbody.append(emptyRow);
  }
  table.querySelector('.statement-total-amount').textContent = summary.billed;
  chargesSection.append(chargesHeading, table);

  const paymentsSection = document.createElement('section');
  paymentsSection.className = 'statement-section statement-payments';
  const paymentHeading = document.createElement('div');
  paymentHeading.className = 'statement-section-heading';
  paymentHeading.innerHTML = '<h2>Repayments received</h2>';
  const paymentTable = document.createElement('table');
  paymentTable.className = 'statement-table statement-payment-table';
  paymentTable.innerHTML = '<thead><tr><th>PAYMENT DATE</th><th>AMOUNT RECEIVED</th><th>NOTE</th></tr></thead><tbody></tbody>';
  for (const payment of payments) {
    const tr = document.createElement('tr');
    for (const value of [formatDate(payment.paidDate), money(payment.amount), payment.note || '—']) {
      const cell = document.createElement('td');
      cell.textContent = value;
      tr.append(cell);
    }
    paymentTable.querySelector('tbody').append(tr);
  }
  if (!payments.length) {
    const emptyRow = document.createElement('tr');
    const emptyCell = document.createElement('td');
    emptyCell.colSpan = 3;
    emptyCell.textContent = 'No repayments recorded for this statement month.';
    emptyRow.append(emptyCell);
    paymentTable.querySelector('tbody').append(emptyRow);
  }
  paymentsSection.append(paymentHeading, paymentTable);

  print.append(brandRow, titleRow, summaryGrid, chargesSection, paymentsSection);
}

function printStatement(personId = '') {
  if (!personId && !state.people.length) {
    showToast('Add a person before creating a ledger statement.', true);
    return;
  }
  if (personId) {
    const person = personFor(personId);
    if (!person) return;
    const account = accountFor(personId);
    const stats = {
      opening: money(account.opening),
      billed: money(account.billed),
      paid: money(account.paid),
      balance: account.balance < -0.01 ? `${money(Math.abs(account.balance))} credit` : money(Math.max(0, account.balance))
    };
    statementMarkup(
      'Monthly account statement',
      `Regular purchases, scheduled EMIs and repayments for ${monthLabel(state.month)}`,
      stats,
      account.currentCharges,
      account.currentPayments.slice().sort((a, b) => a.paidDate.localeCompare(b.paidDate)),
      person
    );
  } else {
    const rows = state.people.map((person) => {
      const account = accountFor(person.id);
      return { type: 'regular', category: 'Person', label: person.name, date: '', amount: account.billed, detail: `Paid ${money(account.paid)} · Balance ${money(account.balance)}` };
    });
    const billed = rows.reduce((sum, row) => sum + row.amount, 0);
    const received = state.payments.filter((payment) => payment.monthKey === state.month).reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
    const balance = state.people.reduce((sum, person) => sum + Math.max(0, accountFor(person.id).balance), 0);
    const summary = { opening: money(0), billed: money(billed), paid: money(received), balance: money(balance) };
    statementMarkup('MyDues · Ledger statement', `Account summary for ${monthLabel(state.month)}`, summary, rows);
  }
  document.body.classList.add('printing-statement');
  window.print();
  window.setTimeout(() => document.body.classList.remove('printing-statement'), 500);
}

function fieldsWithoutId(record) {
  const { id, _legacyRoot, ...fields } = record;
  return fields;
}

function legacyRecordReference(storeSdk, db, user, collectionName, record) {
  return storeSdk.doc(db, 'users', user.uid, collectionName, record.id);
}

function recordGroupReference(storeSdk, db, user, collectionName, personId) {
  return storeSdk.doc(db, 'users', user.uid, collectionName, personId);
}

function recordReference(storeSdk, db, user, collectionName, record) {
  if (collectionName === 'dues') {
    return storeSdk.doc(db, 'users', user.uid, 'dues', record.personId, 'records', record.id);
  }
  if (collectionName === 'emis') {
    return storeSdk.doc(db, 'users', user.uid, 'emis', record.personId, 'plans', record.id);
  }
  return storeSdk.doc(db, 'users', user.uid, collectionName, record.id);
}

function recordGroupFields(personId) {
  return {
    recordGroup: true,
    name: personFor(personId)?.name || personId,
    personId
  };
}

function hasNameBasedPersonId(person) {
  const base = personDocumentIdBase(person.name);
  if (person.id === base) return true;
  const suffix = person.id.startsWith(`${base} (`) && person.id.endsWith(')')
    ? person.id.slice(base.length + 2, -1)
    : '';
  return /^\d+$/.test(suffix);
}

function migrateLegacyPersonDocuments(user, storeSdk, db, legacyRecords, refreshPersonRecordSubscriptions) {
  const people = [...state.people].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const occupiedIds = new Set(people.map((person) => person.id));
  const readableIds = new Set(people.filter(hasNameBasedPersonId).map((person) => person.id));
  const moves = [];

  for (const person of people) {
    if (hasNameBasedPersonId(person)) continue;
    const base = personDocumentIdBase(person.name);
    let targetId = base;
    let suffix = 2;
    while (occupiedIds.has(targetId) || readableIds.has(targetId)) {
      targetId = `${base} (${suffix})`;
      suffix += 1;
    }
    occupiedIds.add(targetId);
    readableIds.add(targetId);
    moves.push({ person, oldId: person.id, newId: targetId });
  }

  const operations = [];
  const personIdMap = new Map(moves.map(({ oldId, newId }) => [oldId, newId]));
  for (const { person, oldId, newId } of moves) {
    person.id = newId;
    operations.push({
      type: 'set',
      ref: storeSdk.doc(db, 'users', user.uid, 'people', newId),
      fields: fieldsWithoutId(person)
    });
    for (const payment of state.payments) {
      if (payment.personId !== oldId) continue;
      payment.personId = newId;
      operations.push({
        type: 'set',
        ref: storeSdk.doc(db, 'users', user.uid, 'payments', payment.id),
        fields: fieldsWithoutId(payment)
      });
    }
    operations.push({
      type: 'delete',
      ref: storeSdk.doc(db, 'users', user.uid, 'people', oldId)
    });
  }

  const groupedParentIds = new Set();
  for (const collectionName of ['dues', 'emis']) {
    const groupDocumentIds = new Set(state.people.map((person) => person.id));
    const reservedRecordIds = new Set(legacyRecords[collectionName].map((record) => record.id));
    const migratedRecordIds = new Set();
    for (const record of legacyRecords[collectionName]) {
      const personId = personIdMap.get(record.personId) || record.personId;
      if (!personId) continue;
      let recordId = record.id;
      if (groupDocumentIds.has(recordId)) {
        do {
          recordId = crypto.randomUUID();
        } while (groupDocumentIds.has(recordId) || reservedRecordIds.has(recordId) || migratedRecordIds.has(recordId));
      }
      migratedRecordIds.add(recordId);
      const migratedRecord = { ...record, id: recordId, personId };
      delete migratedRecord._legacyRoot;
      const groupKey = `${collectionName}:${personId}`;
      if (!groupedParentIds.has(groupKey)) {
        groupedParentIds.add(groupKey);
        operations.push({
          type: 'set',
          ref: recordGroupReference(storeSdk, db, user, collectionName, personId),
          fields: recordGroupFields(personId),
          merge: true
        });
      }
      operations.push({
        type: 'set',
        ref: recordReference(storeSdk, db, user, collectionName, migratedRecord),
        fields: fieldsWithoutId(migratedRecord)
      });
      operations.push({
        type: 'delete',
        ref: legacyRecordReference(storeSdk, db, user, collectionName, record)
      });
    }
  }

  if (!operations.length) return;
  if (moves.length) refreshPersonRecordSubscriptions();
  render();

  for (let index = 0; index < operations.length; index += 450) {
    const batch = storeSdk.writeBatch(db);
    for (const operation of operations.slice(index, index + 450)) {
      if (operation.type === 'delete') batch.delete(operation.ref);
      else if (operation.merge) batch.set(operation.ref, operation.fields, { merge: true });
      else batch.set(operation.ref, operation.fields);
    }
    void batch.commit().catch((error) => {
      console.error(error);
      showToast('Could not reorganize account records in Firestore. Check your connection and rules.', true);
    });
  }
}

async function connectFirebase() {
  setStatus('Connecting…');
  try {
    const version = '10.12.2';
    const appSdk = await import(`https://www.gstatic.com/firebasejs/${version}/firebase-app.js`);
    firebaseAuthSdk = await import(`https://www.gstatic.com/firebasejs/${version}/firebase-auth.js`);
    const storeSdk = await import(`https://www.gstatic.com/firebasejs/${version}/firebase-firestore.js`);
    const app = appSdk.initializeApp(firebaseConfig);
    firebaseAuth = firebaseAuthSdk.getAuth(app);
    const db = storeSdk.initializeFirestore(app, {
      localCache: storeSdk.persistentLocalCache({
        tabManager: storeSdk.persistentMultipleTabManager()
      })
    });

    const subscribe = (user) => {
      activeUnsubscribers.forEach((unsubscribe) => unsubscribe());
      activePersonUnsubscribers.forEach((unsubscribe) => unsubscribe());
      activePersonUnsubscribers = [];
      state.people = [];
      state.dues = [];
      state.emis = [];
      state.payments = [];
      state.personId = '';
      pendingWritesByCollection.clear();
      pendingPersonDocumentIds.clear();
      setView('overview');
      const serverSnapshots = new Set();
      let migrationStarted = false;
      const legacyRecords = { dues: [], emis: [] };
      const nestedRecords = { dues: new Map(), emis: new Map() };
      const personSubscriptions = new Map();
      const nestedCollections = { dues: 'records', emis: 'plans' };
      const refreshRecordState = (collectionName) => {
        const merged = new Map();
        for (const record of legacyRecords[collectionName]) merged.set(record.id, record);
        for (const records of nestedRecords[collectionName].values()) {
          for (const record of records) merged.set(record.id, record);
        }
        state[collectionName] = [...merged.values()];
      };
      const refreshPersonRecordSubscriptions = () => {
        const desired = new Map();
        for (const person of state.people) {
          for (const collectionName of ['dues', 'emis']) {
            const key = `${collectionName}:${person.id}`;
            desired.set(key, { collectionName, person });
          }
        }
        for (const [key, subscription] of personSubscriptions) {
          if (desired.has(key)) continue;
          subscription.unsubscribe();
          personSubscriptions.delete(key);
          nestedRecords[subscription.collectionName].delete(subscription.personId);
          pendingWritesByCollection.delete(`nested:${key}`);
          refreshRecordState(subscription.collectionName);
        }
        for (const [key, { collectionName, person }] of desired) {
          if (personSubscriptions.has(key)) continue;
          const ref = storeSdk.collection(
            db, 'users', user.uid, collectionName, person.id, nestedCollections[collectionName]
          );
          const unsubscribe = storeSdk.onSnapshot(ref, { includeMetadataChanges: true }, (snapshot) => {
            nestedRecords[collectionName].set(person.id, snapshot.docs.map((document) => ({
              ...document.data(),
              id: document.id,
              personId: document.data().personId || person.id
            })));
            pendingWritesByCollection.set(`nested:${key}`, snapshot.metadata.hasPendingWrites);
            refreshRecordState(collectionName);
            updateSyncStatus();
            render();
          }, (error) => {
            console.error(error);
            setStatus('Cloud sync error', 'error');
            showToast(`Could not load ${collectionName} for ${person.name} from Firestore. Check your rules and connection.`, true);
          });
          personSubscriptions.set(key, { unsubscribe, collectionName, personId: person.id });
        }
        activePersonUnsubscribers = [...personSubscriptions.values()].map(({ unsubscribe }) => unsubscribe);
      };
      const refs = {
        people: storeSdk.collection(db, 'users', user.uid, 'people'),
        legacyDues: storeSdk.collection(db, 'users', user.uid, 'dues'),
        legacyEmis: storeSdk.collection(db, 'users', user.uid, 'emis'),
        payments: storeSdk.collection(db, 'users', user.uid, 'payments')
      };
      activeUnsubscribers = Object.entries(refs).map(([key, ref]) =>
        storeSdk.onSnapshot(ref, { includeMetadataChanges: true }, (snapshot) => {
          const documents = snapshot.docs.map((document) => ({ ...document.data(), id: document.id }));
          if (key === 'legacyDues' || key === 'legacyEmis') {
            const collectionName = key === 'legacyDues' ? 'dues' : 'emis';
            legacyRecords[collectionName] = documents
              .filter((record) => record.recordGroup !== true)
              .map((record) => ({ ...record, _legacyRoot: true }));
            refreshRecordState(collectionName);
          } else {
            state[key] = documents;
          }
          if (key === 'people') {
            for (const person of state.people) pendingPersonDocumentIds.delete(person.id);
            refreshPersonRecordSubscriptions();
          }
          pendingWritesByCollection.set(key, snapshot.metadata.hasPendingWrites);
          updateSyncStatus();
          render();
          if (!snapshot.metadata.fromCache) {
            serverSnapshots.add(key);
            if (!migrationStarted && serverSnapshots.size === Object.keys(refs).length) {
              migrationStarted = true;
              migrateLegacyPersonDocuments(user, storeSdk, db, legacyRecords, refreshPersonRecordSubscriptions);
            }
          }
        }, (error) => {
          console.error(error);
          setStatus('Cloud sync error', 'error');
          showToast(`Could not load ${key.replace('legacy', '')} from Firestore. Check your rules and connection.`, true);
        })
      );
    };

    window.myDuesStore = {
      add: (collectionName, record) => {
        const user = firebaseAuth.currentUser;
        if (!isGoogleAccount(user)) throw new Error('Sign in with Google before saving records.');
        const { id, ...fields } = record;
        let write;
        if (collectionName === 'dues' || collectionName === 'emis') {
          const batch = storeSdk.writeBatch(db);
          batch.set(
            recordGroupReference(storeSdk, db, user, collectionName, record.personId),
            recordGroupFields(record.personId),
            { merge: true }
          );
          batch.set(recordReference(storeSdk, db, user, collectionName, record), fields);
          write = batch.commit();
        } else {
          write = storeSdk.setDoc(storeSdk.doc(db, 'users', user.uid, collectionName, id), fields);
        }
        void write.catch((error) => {
          if (collectionName === 'people') pendingPersonDocumentIds.delete(id);
          console.error(error);
          showToast(`Could not sync this ${collectionName === 'people' ? 'person' : collectionName.slice(0, -1)} to Firestore. Check your connection and rules.`, true);
        });
        return Promise.resolve();
      },
      update: (collectionName, record, previousRecord) => {
        const user = firebaseAuth.currentUser;
        if (!isGoogleAccount(user)) throw new Error('Sign in with Google before saving records.');
        const { id, ...fields } = record;
        let write;
        if (collectionName === 'dues' || collectionName === 'emis') {
          const batch = storeSdk.writeBatch(db);
          const nextRef = recordReference(storeSdk, db, user, collectionName, record);
          const previousRef = previousRecord?._legacyRoot
            ? legacyRecordReference(storeSdk, db, user, collectionName, previousRecord)
            : recordReference(storeSdk, db, user, collectionName, previousRecord || record);
          batch.set(
            recordGroupReference(storeSdk, db, user, collectionName, record.personId),
            recordGroupFields(record.personId),
            { merge: true }
          );
          batch.set(nextRef, fields);
          if (previousRef.path !== nextRef.path) batch.delete(previousRef);
          write = batch.commit();
        } else {
          write = storeSdk.updateDoc(storeSdk.doc(db, 'users', user.uid, collectionName, id), fields);
        }
        void write.catch((error) => {
          console.error(error);
          showToast(`Could not update this ${collectionName === 'dues' ? 'regular due' : collectionName === 'emis' ? 'EMI plan' : collectionName.slice(0, -1)} in Firestore. Check your connection and rules.`, true);
        });
        return Promise.resolve();
      },
      delete: (collectionName, record) => {
        const user = firebaseAuth.currentUser;
        if (!isGoogleAccount(user)) throw new Error('Sign in with Google before deleting records.');
        const ref = record?._legacyRoot && (collectionName === 'dues' || collectionName === 'emis')
          ? legacyRecordReference(storeSdk, db, user, collectionName, record)
          : recordReference(storeSdk, db, user, collectionName, record);
        const write = storeSdk.deleteDoc(ref);
        void write.catch((error) => {
          console.error(error);
          showToast(`Could not delete this ${collectionName === 'dues' ? 'regular due' : collectionName === 'emis' ? 'EMI plan' : collectionName.slice(0, -1)} from Firestore. Check your connection and rules.`, true);
        });
        return Promise.resolve();
      }
    };

    firebaseAuthSdk.onAuthStateChanged(firebaseAuth, (user) => {
      state.user = user;
      renderAccountControl(user);
      if (isGoogleAccount(user)) {
        $('#startupGateError').hidden = true;
        hideStartupGate();
        subscribe(user);
      } else {
        showStartupGate();
        activeUnsubscribers.forEach((unsubscribe) => unsubscribe());
        activePersonUnsubscribers.forEach((unsubscribe) => unsubscribe());
        activeUnsubscribers = [];
        activePersonUnsubscribers = [];
        state.people = [];
        state.dues = [];
        state.emis = [];
        state.payments = [];
        state.personId = '';
        pendingWritesByCollection.clear();
        pendingPersonDocumentIds.clear();
        setView('overview');
        setStatus('Google sign-in required');
      }
      markAuthReady();
    });
  } catch (error) {
    console.error(error);
    state.user = null;
    renderAccountControl(null);
    showStartupGateError('Firebase could not start. Check firebase-config.js and your connection.');
    setStatus('Cloud setup error', 'error');
    markAuthReady();
  }
}

window.addEventListener('offline', updateSyncStatus);
window.addEventListener('online', updateSyncStatus);

function showPerson(personId) {
  state.personId = personId;
  setView('person');
}

function wireEvents() {
  $('#startupGate').addEventListener('cancel', (event) => event.preventDefault());
  $('#startupSignInButton').addEventListener('click', () => {
    $('#startupGateError').hidden = true;
    void ensureGoogleSignIn();
  });
  $('#accountTrigger').addEventListener('click', async () => {
    if (!isGoogleAccount(state.user)) {
      await ensureGoogleSignIn();
      return;
    }
    const menu = $('#accountMenu');
    menu.hidden = !menu.hidden;
    $('#accountTrigger').setAttribute('aria-expanded', String(!menu.hidden));
  });
  $('#installAppButton').addEventListener('click', async () => {
    const installPrompt = deferredInstallPrompt;
    if (!installPrompt) {
      if (isInstalledApp()) {
        showToast('MyDues is already installed.');
        return;
      }
      if (!window.isSecureContext) {
        showToast('PWA installation requires HTTPS or localhost.', true);
        return;
      }
      if (!('serviceWorker' in navigator)) {
        showToast('This browser does not support PWA installation.', true);
        return;
      }
      try {
        const registration = await navigator.serviceWorker.getRegistration();
        showToast(registration?.active
          ? 'Chrome has not marked this page installable yet. Check the manifest and service worker.'
          : 'MyDues is not ready to install yet. Reload after its service worker activates.', true);
      } catch (error) {
        console.error(error);
        showToast('Could not check MyDues install readiness.', true);
      }
      return;
    }
    deferredInstallPrompt = null;
    window.myDuesInstallPrompt = null;
    try {
      await installPrompt.prompt();
      const { outcome } = await installPrompt.userChoice;
      if (outcome === 'accepted') {
        installedThisSession = true;
        window.myDuesInstalled = true;
        showToast('MyDues is being installed.');
      }
    } catch (error) {
      console.error(error);
      showToast('Could not open the install prompt. Please try again.', true);
    }
  });
  $('#signOutButton').addEventListener('click', async () => {
    try {
      await firebaseAuthSdk.signOut(firebaseAuth);
    } catch (error) {
      console.error(error);
      showToast(`Sign-out failed: ${error.message || 'Please try again.'}`, true);
    }
  });
  document.addEventListener('click', (event) => {
    if (!event.target.closest('.account-control')) {
      $('#accountMenu').hidden = true;
      $('#accountTrigger').setAttribute('aria-expanded', 'false');
    }
  });
  document.addEventListener('click', async (event) => {
    const viewButton = event.target.closest('[data-view]');
    if (viewButton) {
      setView(viewButton.dataset.view);
      return;
    }
    const action = event.target.closest('[data-action]');
    if (!action) return;
    const personId = action.dataset.personId || action.closest('[data-person-id]')?.dataset.personId || state.personId;
    if (action.dataset.action === 'add-person') {
      void showFormAfterSignIn('personForm');
      return;
    }
    if (['add-due', 'add-emi', 'add-payment'].includes(action.dataset.action) && !state.people.length) {
      showToast('Add a person before recording account activity.', true);
      return;
    }
    if (action.dataset.action === 'open-person') {
      showPerson(personId);
      return;
    }
    const formIds = {
      'add-due': 'dueForm',
      'add-emi': 'emiForm',
      'add-payment': 'paymentForm'
    };
    if (formIds[action.dataset.action]) {
      void showFormAfterSignIn(formIds[action.dataset.action], personId);
      return;
    }
    const editTargets = {
      'edit-due': { collection: 'dues', formId: 'dueForm' },
      'edit-emi': { collection: 'emis', formId: 'emiForm' },
      'edit-payment': { collection: 'payments', formId: 'paymentForm' }
    };
    if (editTargets[action.dataset.action]) {
      const { collection, formId } = editTargets[action.dataset.action];
      const record = state[collection].find((entry) => entry.id === action.dataset.recordId);
      if (!record) {
        showToast('This record is no longer available. Refreshing its account data may help.', true);
        return;
      }
      void showFormAfterSignIn(formId, record.personId, record);
      return;
    }
    const deleteCollections = {
      'delete-due': 'dues',
      'delete-emi': 'emis',
      'delete-payment': 'payments'
    };
    if (deleteCollections[action.dataset.action]) {
      const collection = deleteCollections[action.dataset.action];
      const record = state[collection].find((entry) => entry.id === action.dataset.recordId);
      if (!record) {
        showToast('This record is no longer available. Refreshing its account data may help.', true);
        return;
      }
      const description = collection === 'emis'
        ? `Delete the ${record.provider || 'EMI'} plan? Its scheduled instalments will be removed from account totals.`
        : collection === 'dues'
          ? `Delete ${record.description || record.category || 'this regular due'}? The account balance will be recalculated.`
          : 'Delete this repayment? The account balance will be recalculated.';
      if (!window.confirm(description)) return;
      try {
        await window.myDuesStore.delete(collection, record);
        showToastForDelete(collection === 'dues' ? 'Regular due' : collection === 'emis' ? 'EMI plan' : 'Repayment');
      } catch (error) {
        console.error(error);
        showToast(error instanceof Error ? error.message : 'Could not delete this record.', true);
      }
      return;
    }
    if (action.dataset.action === 'person-statement') printStatement(personId);
  });

  $('#statementDatePicker').addEventListener('change', (event) => {
    if (event.target.value) {
      state.statementDate = event.target.value;
      state.month = monthOf(event.target.value);
      render();
    }
  });
  $('#regularPurchaseDate').addEventListener('change', (event) => {
    const form = $('#dueForm');
    const dueDate = form.elements.dueDate;
    if (dueDate.value === form.dataset.suggestedDueDate) {
      dueDate.value = addCalendarMonths(event.target.value, 1);
      form.dataset.suggestedDueDate = dueDate.value;
    }
  });
  $('.dialog-close').addEventListener('click', () => $('#formDialog').close());
  $('#formDialog').addEventListener('click', (event) => {
    if (event.target === $('#formDialog')) $('#formDialog').close();
  });
  $('.mobile-menu').addEventListener('click', () => $('.sidebar').classList.toggle('open'));
  $('#allStatementButton').addEventListener('click', () => printStatement());
  $('#personStatementButton').addEventListener('click', () => printStatement(state.personId));

  $('#emiForm').addEventListener('input', updateEmiPreview);

  const submissions = [
    ['personForm', addPerson, 'Person account'],
    ['dueForm', addRegularDue, 'Regular due'],
    ['emiForm', addEmi, 'EMI plan'],
    ['paymentForm', addRepayment, 'Repayment']
  ];
  for (const [formId, save, recordName] of submissions) {
    $(`#${formId}`).addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const data = Object.fromEntries(new FormData(form));
      const error = form.querySelector('.dialog-error');
      error.textContent = '';
      try {
        await save(data, form.dataset.recordId);
        $('#formDialog').close();
        showToastForSave(recordName, Boolean(form.dataset.recordId));
      } catch (reason) {
        console.error(reason);
        error.textContent = reason instanceof Error ? reason.message : `Could not save this ${recordName.toLowerCase()}. Check your Google sign-in and Firebase connection.`;
      }
    });
  }
}

function start() {
  wireEvents();
  $('#startupGate').showModal();
  $('#statementDatePicker').value = state.statementDate;
  renderAccountControl(null);
  render();
  if (firebaseConfigured) connectFirebase();
  else {
    setStatus('Firebase setup required', 'error');
    showStartupGateError('Firebase must be configured before you can sign in.');
    markAuthReady();
  }
}

start();
