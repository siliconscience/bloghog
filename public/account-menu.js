// Shared "account menu" widget: click the username in the header to change your
// password or profile photo. Included by every authenticated page (dashboard,
// blog, calendar, post) so this logic lives in one place instead of four.
//
// Usage: <script src="account-menu.js"></script>, then call initAccountMenu(username)
// once the current user's username is known (after fetching /auth/me).

function initAccountMenu(username) {
  const trigger = document.getElementById('username-display');
  if (!trigger) return;
  trigger.textContent = username;
  trigger.style.cursor = 'pointer';
  trigger.title = 'Account settings';

  buildAccountMenuDom();

  const avatarImg = document.getElementById('account-avatar-img');
  const avatarPlaceholder = document.getElementById('account-avatar-placeholder');
  function refreshAvatar() {
    avatarImg.style.display = '';
    avatarPlaceholder.style.display = 'none';
    avatarImg.src = `/data/avatars/${encodeURIComponent(username)}.jpg?t=${Date.now()}`;
  }
  avatarImg.onerror = () => { avatarImg.style.display = 'none'; avatarPlaceholder.style.display = 'flex'; };
  refreshAvatar();

  trigger.onclick = e => {
    e.stopPropagation();
    document.getElementById('account-menu-dropdown').classList.toggle('open');
  };
  document.addEventListener('click', () => document.getElementById('account-menu-dropdown').classList.remove('open'));
  document.getElementById('account-menu-dropdown').addEventListener('click', e => e.stopPropagation());

  document.getElementById('account-avatar-input').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    const form = new FormData();
    form.append('avatar', file);
    const res = await fetch('/api/account/avatar', { method: 'POST', body: form });
    if (res.ok) {
      refreshAvatar();
    } else {
      const d = await res.json();
      alert('Photo upload failed: ' + d.error);
    }
    e.target.value = '';
  });

  document.getElementById('account-password-form').addEventListener('submit', async e => {
    e.preventDefault();
    const currentPassword = document.getElementById('account-current-password').value;
    const newPassword = document.getElementById('account-new-password').value;
    const confirmPassword = document.getElementById('account-confirm-password').value;
    const msg = document.getElementById('account-password-msg');
    msg.innerHTML = '';
    if (newPassword !== confirmPassword) {
      msg.innerHTML = '<div class="error-msg">New passwords do not match</div>';
      return;
    }
    const res = await fetch('/api/account/password', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword, newPassword })
    });
    const data = await res.json();
    if (res.ok) {
      closeAccountPasswordModal();
    } else {
      msg.innerHTML = `<div class="error-msg">${data.error}</div>`;
    }
  });

  document.getElementById('account-username-form').addEventListener('submit', async e => {
    e.preventDefault();
    const newUsername = document.getElementById('account-new-username').value;
    const currentPassword = document.getElementById('account-username-password').value;
    const msg = document.getElementById('account-username-msg');
    msg.innerHTML = '';
    const res = await fetch('/api/account/username', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newUsername, currentPassword })
    });
    const data = await res.json();
    if (res.ok) {
      window.location.reload();
    } else {
      msg.innerHTML = `<div class="error-msg">${data.error}</div>`;
    }
  });
}

function openAccountPasswordModal() {
  document.getElementById('account-menu-dropdown').classList.remove('open');
  document.getElementById('account-password-modal').classList.add('open');
}
function closeAccountPasswordModal() {
  document.getElementById('account-password-modal').classList.remove('open');
  document.getElementById('account-password-form').reset();
  document.getElementById('account-password-msg').innerHTML = '';
}

function openAccountUsernameModal() {
  document.getElementById('account-menu-dropdown').classList.remove('open');
  document.getElementById('account-username-modal').classList.add('open');
}
function closeAccountUsernameModal() {
  document.getElementById('account-username-modal').classList.remove('open');
  document.getElementById('account-username-form').reset();
  document.getElementById('account-username-msg').innerHTML = '';
}

function buildAccountMenuDom() {
  if (document.getElementById('account-menu-dropdown')) return; // already built

  const userInfo = document.getElementById('username-display').closest('.user-info');
  if (userInfo) userInfo.style.position = 'relative';

  const dropdown = document.createElement('div');
  dropdown.id = 'account-menu-dropdown';
  dropdown.className = 'account-menu-dropdown';
  dropdown.innerHTML = `
    <div class="account-menu-avatar-row">
      <div class="account-avatar-wrap" onclick="document.getElementById('account-avatar-input').click()" title="Click to change photo">
        <img id="account-avatar-img" class="account-avatar-img" alt="">
        <div id="account-avatar-placeholder" class="account-avatar-placeholder">+</div>
      </div>
      <span class="account-menu-hint">Click photo to change</span>
    </div>
    <button type="button" class="btn btn-secondary btn-sm" style="width:100%; margin-bottom:0.4rem" onclick="openAccountPasswordModal()">Change Password</button>
    <button type="button" class="btn btn-secondary btn-sm" style="width:100%" onclick="openAccountUsernameModal()">Change Username</button>
  `;
  (userInfo || document.body).appendChild(dropdown);

  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.id = 'account-avatar-input';
  input.style.display = 'none';
  document.body.appendChild(input);

  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.id = 'account-password-modal';
  modal.innerHTML = `
    <div class="modal">
      <h3>Change Password</h3>
      <div id="account-password-msg"></div>
      <form id="account-password-form">
        <label>Current Password</label>
        <input type="password" id="account-current-password" required>
        <label>New Password</label>
        <input type="password" id="account-new-password" required>
        <label>Confirm New Password</label>
        <input type="password" id="account-confirm-password" required>
        <div class="modal-actions">
          <button type="button" class="btn btn-secondary" onclick="closeAccountPasswordModal()">Cancel</button>
          <button type="submit" class="btn btn-primary">Save</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(modal);

  const usernameModal = document.createElement('div');
  usernameModal.className = 'modal-overlay';
  usernameModal.id = 'account-username-modal';
  usernameModal.innerHTML = `
    <div class="modal">
      <h3>Change Username</h3>
      <div id="account-username-msg"></div>
      <form id="account-username-form">
        <label>New Username</label>
        <input type="text" id="account-new-username" required pattern="[a-zA-Z0-9_-]{3,32}" title="3-32 characters: letters, numbers, underscore, hyphen">
        <label>Current Password</label>
        <input type="password" id="account-username-password" required>
        <div class="modal-actions">
          <button type="button" class="btn btn-secondary" onclick="closeAccountUsernameModal()">Cancel</button>
          <button type="submit" class="btn btn-primary">Save</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(usernameModal);
}
