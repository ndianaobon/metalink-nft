// ==================== MetaLinkNFT SPA ====================
const App = {
  token: localStorage.getItem('mlk_token'),
  user: JSON.parse(localStorage.getItem('mlk_user') || 'null'),
  currentPage: 'home',
  currentTab: 'stake',

  async api(endpoint, options = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (this.token) headers['Authorization'] = 'Bearer ' + this.token;
    try {
      const res = await fetch('/api' + endpoint, { ...options, headers });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Something went wrong');
      return data;
    } catch (e) {
      if (e.message === 'Unauthorized') { this.logout(); }
      throw e;
    }
  },

  toast(msg, type = 'error') {
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3000);
  },

  login(token, user) {
    this.token = token;
    this.user = user;
    localStorage.setItem('mlk_token', token);
    localStorage.setItem('mlk_user', JSON.stringify(user));
    this.navigate('stake');
  },

  logout() {
    this.token = null;
    this.user = null;
    localStorage.removeItem('mlk_token');
    localStorage.removeItem('mlk_user');
    this.navigate('login');
  },

  navigate(page, data = {}) {
    this.currentPage = page;
    this.pageData = data;
    window.location.hash = '#/' + page;
    this.render();
    window.scrollTo(0, 0);
  },

  init() {
    window.addEventListener('hashchange', () => {
      const hash = window.location.hash.replace('#/', '') || 'landing';
      const [page, ...rest] = hash.split('/');
      this.currentPage = page;
      this.pageData = { id: rest.join('/') };
      this.render();
    });

    const hash = window.location.hash.replace('#/', '');
    if (hash) {
      const [page, ...rest] = hash.split('/');
      this.currentPage = page;
      this.pageData = { id: rest.join('/') };
    } else if (this.token) {
      this.currentPage = 'stake';
    } else {
      this.currentPage = 'landing';
    }
    this.render();
  },

  render() {
    const app = document.getElementById('app');
    const authPages = ['landing', 'login', 'signup', 'forgot-password'];
    const appPages = ['stake', 'earn', 'reserve', 'assets', 'my', 'announcements', 'announcement-detail', 'withdraw', 'deposit', 'settings', 'team', 'locked-savings', 'details', 'mint', 'collection'];

    if (authPages.includes(this.currentPage)) {
      app.innerHTML = this.renderAuthPage();
    } else if (appPages.includes(this.currentPage)) {
      if (!this.token) { this.navigate('login'); return; }
      app.innerHTML = this.renderAppLayout();
    } else {
      this.currentPage = this.token ? 'stake' : 'landing';
      this.render();
      return;
    }
    this.bindEvents();
  },

  // ==================== AUTH PAGES ====================
  renderAuthPage() {
    if (this.currentPage === 'landing') return this.renderLanding();
    if (this.currentPage === 'login') return this.renderLogin();
    if (this.currentPage === 'signup') return this.renderSignup();
    if (this.currentPage === 'forgot-password') return this.renderForgotPassword();
  },

  renderLanding() {
    return `
      <div class="landing-page">
        <div class="landing-bg-glow"></div>
        <div class="landing-content">
          <div class="landing-logo">
            <img src="/assets/images/MetaLink-NFT-icon.png" alt="MetaLinkNFT">
          </div>
          <h1 class="landing-title">MetaLink<span>NFT</span></h1>
          <p class="landing-tagline">The Trusted NFT Marketplace</p>
          <div class="landing-features">
            <div class="landing-feature">
              <div class="landing-feature-icon">&#128176;</div>
              <div class="landing-feature-text">
                <h4>Stake & Earn</h4>
                <p>Earn daily rewards by staking NFTs</p>
              </div>
            </div>
            <div class="landing-feature">
              <div class="landing-feature-icon">&#127912;</div>
              <div class="landing-feature-text">
                <h4>NFT Trading</h4>
                <p>Trade premium digital collectibles</p>
              </div>
            </div>
            <div class="landing-feature">
              <div class="landing-feature-icon">&#128274;</div>
              <div class="landing-feature-text">
                <h4>Secure Wallet</h4>
                <p>Safe and protected transactions</p>
              </div>
            </div>
          </div>
          <div class="landing-actions">
            <button class="landing-btn landing-btn-primary" onclick="App.navigate('login')">Sign In</button>
            <button class="landing-btn landing-btn-outline" onclick="App.navigate('signup')">Create Account</button>
          </div>
          <p class="landing-footer">Powered by MetaLink &middot; NFT Marketplace</p>
        </div>
      </div>`;
  },


  renderLogin() {
    return `
      <div class="auth-page">
        <div class="auth-card">
          <div class="auth-logo">
            <img src="/assets/images/MetaLink-NFT-icon.png" alt="MetaLinkNFT">
            <h2>METALINK</h2>
          </div>
          <h3 class="auth-title">Sign in to your account</h3>
          <p class="auth-subtitle">Enter your email and password to sign in</p>
          <form id="loginForm">
            <div class="form-group">
              <label class="form-label"><span class="required">*</span> Account</label>
              <input type="email" class="form-input" id="loginEmail" placeholder="Enter your email" required>
            </div>
            <div class="form-group">
              <label class="form-label"><span class="required">*</span> Password</label>
              <div class="password-group">
                <input type="password" class="form-input" id="loginPassword" placeholder="Enter password" required>
                <button type="button" class="password-toggle" onclick="this.previousElementSibling.type = this.previousElementSibling.type === 'password' ? 'text' : 'password'">&#128065;</button>
              </div>
            </div>
            <div class="auth-forgot">
              <a href="#" onclick="App.navigate('forgot-password');return false;">Forgot Password?</a>
            </div>
            <button type="submit" class="btn-auth btn-auth-primary">Sign In</button>
          </form>
          <div class="auth-links">
            No account? <a href="#" onclick="App.navigate('signup');return false;">SIGN UP</a>
          </div>
        </div>
      </div>`;
  },

  renderSignup() {
    return `
      <div class="auth-page">
        <button class="auth-back" onclick="App.navigate('login')">&#8592;</button>
        <div class="auth-card">
          <div class="auth-logo">
            <img src="/assets/images/MetaLink-NFT-icon.png" alt="MetaLinkNFT">
            <h2>METALINK</h2>
          </div>
          <h3 class="auth-title">Create Account</h3>
          <p class="auth-subtitle">Sign up to start trading NFTs</p>
          <form id="signupForm">
            <div class="form-group">
              <label class="form-label"><span class="required">*</span> Email</label>
              <input type="email" class="form-input" id="signupEmail" placeholder="Enter your email" required>
            </div>
            <div class="form-group">
              <label class="form-label"><span class="required">*</span> Referral Code (optional)</label>
              <input type="text" class="form-input" id="signupReferral" placeholder="Enter referral code">
            </div>
            <div class="form-group">
              <label class="form-label"><span class="required">*</span> Password</label>
              <div class="password-group">
                <input type="password" class="form-input" id="signupPassword" placeholder="Min 6 characters" required>
                <button type="button" class="password-toggle" onclick="this.previousElementSibling.type = this.previousElementSibling.type === 'password' ? 'text' : 'password'">&#128065;</button>
              </div>
            </div>
            <div class="form-group">
              <label class="form-label"><span class="required">*</span> Confirm Password</label>
              <div class="password-group">
                <input type="password" class="form-input" id="signupConfirm" placeholder="Re-enter password" required>
                <button type="button" class="password-toggle" onclick="this.previousElementSibling.type = this.previousElementSibling.type === 'password' ? 'text' : 'password'">&#128065;</button>
              </div>
            </div>
            <button type="submit" class="btn-auth btn-auth-primary">Submit</button>
          </form>
          <div class="auth-links">
            Already have an account? <a href="#" onclick="App.navigate('login');return false;">SIGN IN</a>
          </div>
        </div>
      </div>`;
  },

  renderForgotPassword() {
    return `
      <div class="auth-page">
        <button class="auth-back" onclick="App.navigate('login')">&#8592;</button>
        <div class="auth-card">
          <h3 class="auth-title">Forgot Password?</h3>
          <form id="forgotForm">
            <div class="form-group">
              <label class="form-label"><span class="required">*</span> Email</label>
              <input type="email" class="form-input" id="forgotEmail" placeholder="Enter your email" required>
            </div>
            <div class="form-group">
              <label class="form-label"><span class="required">*</span> Password</label>
              <div class="password-group">
                <input type="password" class="form-input" id="forgotPassword" placeholder="New password" required>
                <button type="button" class="password-toggle" onclick="this.previousElementSibling.type = this.previousElementSibling.type === 'password' ? 'text' : 'password'">&#128065;</button>
              </div>
            </div>
            <div class="form-group">
              <label class="form-label"><span class="required">*</span> Confirm Password</label>
              <div class="password-group">
                <input type="password" class="form-input" id="forgotConfirm" placeholder="Re-enter new password" required>
                <button type="button" class="password-toggle" onclick="this.previousElementSibling.type = this.previousElementSibling.type === 'password' ? 'text' : 'password'">&#128065;</button>
              </div>
            </div>
            <button type="submit" class="btn-auth btn-auth-primary">Submit</button>
            <button type="button" class="btn-auth" style="background:#eee;color:#333;margin-top:8px;" onclick="App.navigate('login')">Cancel</button>
          </form>
        </div>
      </div>`;
  },

  // ==================== APP LAYOUT ====================
  renderAppLayout() {
    const page = this.currentPage;
    let content = '';
    if (page === 'stake') content = this.renderStakePage();
    else if (page === 'earn') content = this.renderEarnPage();
    else if (page === 'reserve') content = this.renderReservePage();
    else if (page === 'assets') content = this.renderAssetsPage();
    else if (page === 'my') content = this.renderMyPage();
    else if (page === 'announcements') content = this.renderAnnouncementsPage();
    else if (page === 'announcement-detail') content = this.renderAnnouncementDetailPage();
    else if (page === 'withdraw') content = this.renderWithdrawPage();
    else if (page === 'deposit') content = this.renderDepositPage();
    else if (page === 'settings') content = this.renderSettingsPage();
    else if (page === 'team') content = this.renderTeamPage();
    else if (page === 'locked-savings') content = this.renderLockedSavingsPage();
    else if (page === 'details') content = this.renderDetailsPage();
    else if (page === 'mint') content = this.renderMintPage();
    else if (page === 'collection') content = this.renderCollectionPage();

    const navItems = [
      { id: 'stake', label: 'Stake', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>' },
      { id: 'earn', label: 'Earn', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>' },
      { id: 'reserve', label: 'Reserve', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>' },
      { id: 'assets', label: 'Assets', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M22 10H18a2 2 0 0 0 0 4h4"/></svg>' },
      { id: 'my', label: 'My', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>' },
    ];

    return `
      <div class="app-layout">
        <header class="top-header">
          <div class="top-header-logo">
            <img src="/assets/images/MetaLink-NFT-horizontal-dark.svg" alt="MetaLinkNFT">
          </div>
          <div class="top-header-actions">
            <button onclick="App.navigate('announcements')" title="Notifications">
              &#128276;<span class="notification-dot" id="notifDot"></span>
            </button>
            <button title="Language">&#127760;</button>
            <button onclick="App.toggleMenu()" title="Menu">&#9776;</button>
          </div>
        </header>
        <main class="app-content">${content}</main>
        <nav class="bottom-nav">
          ${navItems.map(n => `
            <button class="bottom-nav-item ${page === n.id ? 'active' : ''}" onclick="App.navigate('${n.id}')">
              ${n.icon}<span>${n.label}</span>
            </button>
          `).join('')}
        </nav>
        <div class="side-menu-overlay" id="sideMenu" onclick="if(event.target===this)App.toggleMenu()">
          <div class="side-menu">
            <button class="side-menu-item" onclick="App.navigate('stake');App.toggleMenu()">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="24" height="24"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"/></svg>
              Home
            </button>
            <button class="side-menu-item" onclick="App.navigate('announcements');App.toggleMenu()">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="24" height="24"><path d="M22 17H2a3 3 0 006 0h8a3 3 0 006 0zM13.73 21a2 2 0 01-3.46 0"/><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/></svg>
              Announcements
            </button>
            <button class="side-menu-item" onclick="window.open('https://t.me/metalinknft','_blank');App.toggleMenu()">
              <svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.479.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>
              Telegram
            </button>
            <button class="side-menu-item" onclick="App.navigate('settings');App.toggleMenu()">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="24" height="24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>
              Settings
            </button>
            <button class="side-menu-item" style="color:var(--negative);margin-top:auto;" onclick="App.logout();App.toggleMenu()">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="24" height="24"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/></svg>
              Sign Out
            </button>
          </div>
        </div>
      </div>`;
  },

  toggleMenu() {
    document.getElementById('sideMenu')?.classList.toggle('active');
  },

  // ==================== STAKE PAGE ====================
  renderStakePage() {
    return `
      <div class="hero-banner">
        <span class="hero-banner-corner tl">NFT Powered by</span>
        <span class="hero-banner-corner br">by METALINK</span>
        <div class="hero-banner-text">
          <h1>The trusted NFT marketplace MetaLink</h1>
          <p>Earn rewards through NFT trading on MetaLink</p>
        </div>
      </div>
      <div id="nftCardsScroll" class="nft-scroll"></div>
      <div class="page-section">
        <div class="tabs">
          <button class="tab-btn active" data-tab="stake-tab">Stake</button>
          <button class="tab-btn" data-tab="polygon-tab">PolygonNFT</button>
          <button class="tab-btn" data-tab="art-tab">Art</button>
          <button class="tab-btn" data-tab="collectibles-tab">Collectibles</button>
        </div>
        <div class="sub-tabs">
          <button class="sub-tab-btn active" data-subtab="available">Stake</button>
          <button class="sub-tab-btn" data-subtab="mystake">My Stake</button>
          <button class="sub-tab-btn" data-subtab="collection">Collection</button>
        </div>
        <div id="stakeContent"><div class="empty-state"><div class="spinner"></div><p>Loading...</p></div></div>
      </div>`;
  },

  async loadStakeContent(filter = 'all', subtab = 'available') {
    const container = document.getElementById('stakeContent');
    if (!container) return;

    if (subtab === 'available') {
      try {
        const catalog = await this.api('/stakes/catalog');
        const filtered = filter === 'all' ? catalog : catalog.filter(c => c.collection.toLowerCase().includes(filter));
        if (filtered.length === 0) {
          container.innerHTML = '<div class="empty-state"><p>No NFTs available</p></div>';
          return;
        }
        container.innerHTML = filtered.map(nft => `
          <div class="stake-card">
            <div class="stake-nft-img" style="background:${nft.color};">&#127912;</div>
            <div class="stake-info">
              <h4>${nft.name}</h4>
              <div class="collection">${nft.collection}</div>
              <div class="stake-detail"><span class="stake-detail-label">Pledge Range</span><span class="stake-detail-value">${nft.pledgeRange} USDT</span></div>
              <div class="stake-detail"><span class="stake-detail-label">Daily Income</span><span class="stake-detail-value">${nft.dailyIncome}</span></div>
              <div class="stake-detail"><span class="stake-detail-label">Duration</span><span class="stake-detail-value">${nft.duration} days</span></div>
              <button class="btn-claim btn-claim-active" onclick="App.showStakeModal('${nft.id}','${nft.name}','${nft.pledgeRange}')">Stake Now</button>
            </div>
          </div>
        `).join('');
      } catch (e) { container.innerHTML = '<div class="empty-state"><p>Failed to load</p></div>'; }
    } else if (subtab === 'mystake') {
      try {
        const stakes = await this.api('/stakes/my');
        if (stakes.length === 0) {
          container.innerHTML = '<div class="empty-state"><p>No active stakes</p></div>';
          return;
        }
        container.innerHTML = stakes.map(s => {
          const now = new Date();
          const end = new Date(s.endDate);
          const daysLeft = Math.max(0, ((end - now) / (1000*60*60*24))).toFixed(2);
          const dailyRate = parseFloat(s.dailyIncome) / 100;
          const start = new Date(s.startDate);
          const elapsed = Math.min((now - start) / (1000*60*60*24), s.duration);
          const currentIncome = (s.pledgeValue * dailyRate * elapsed).toFixed(5);
          return `
            <div class="stake-card">
              <div class="stake-nft-img" style="background:${s.color};">&#127912;</div>
              <div class="stake-info">
                <h4>${s.nftName} ${s.nftNumber}</h4>
                <div class="collection">${s.collection}</div>
                <div class="stake-detail"><span class="stake-detail-label">Pledge Value</span><span class="stake-detail-value">${s.pledgeValue.toFixed(2)} USDT</span></div>
                <div class="stake-detail"><span class="stake-detail-label">Daily Income</span><span class="stake-detail-value">${s.dailyIncome}</span></div>
                <div class="stake-detail"><span class="stake-detail-label">Time left</span><span class="stake-detail-value">${daysLeft} days</span></div>
                <div class="stake-detail"><span class="stake-detail-label">Income</span><span class="stake-detail-value red">${currentIncome} USDT</span></div>
                <div class="stake-detail"><span class="stake-detail-label">Expected Total</span><span class="stake-detail-value">${s.expectedTotal.toFixed(5)} USDT</span></div>
                <button class="btn-claim ${s.claimed ? 'btn-claim-disabled' : 'btn-claim-active'}" ${s.claimed ? 'disabled' : `onclick="App.claimStake('${s.id}')"`}>
                  ${s.claimed ? 'Claimed' : 'Claim'}
                </button>
              </div>
            </div>`;
        }).join('');
      } catch (e) { container.innerHTML = '<div class="empty-state"><p>Failed to load</p></div>'; }
    } else {
      container.innerHTML = '<div class="empty-state"><p>No items in collection</p></div>';
    }
  },

  async showStakeModal(nftId, name, range) {
    const [min, max] = range.split(' - ').map(s => parseInt(s));
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay active';
    overlay.innerHTML = `
      <div class="modal-box">
        <h3 class="modal-title">Stake ${name}</h3>
        <p class="modal-text">Enter amount (${min} - ${max} USDT)</p>
        <input type="number" class="admin-form-input" id="stakeAmountInput" placeholder="Amount" min="${min}" max="${max}" style="margin-bottom:16px;">
        <div class="modal-actions">
          <button class="modal-btn modal-btn-cancel" onclick="this.closest('.modal-overlay').remove()">Cancel</button>
          <button class="modal-btn modal-btn-confirm" onclick="App.confirmStake('${nftId}')">Confirm</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
  },

  async confirmStake(nftId) {
    const input = document.getElementById('stakeAmountInput');
    const amount = parseFloat(input.value);
    if (!amount) { this.toast('Enter an amount'); return; }
    try {
      await this.api('/stakes', { method: 'POST', body: JSON.stringify({ nftId, amount }) });
      document.querySelector('.modal-overlay')?.remove();
      this.toast('Staked successfully!', 'success');
      this.loadStakeContent('all', 'mystake');
      document.querySelectorAll('.sub-tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.sub-tab-btn')[1]?.classList.add('active');
    } catch (e) { this.toast(e.message); }
  },

  async claimStake(id) {
    try {
      const res = await this.api(`/stakes/${id}/claim`, { method: 'POST' });
      this.toast(`Claimed ${res.income} USDT!`, 'success');
      this.loadStakeContent('all', 'mystake');
    } catch (e) { this.toast(e.message); }
  },

  // ==================== EARN PAGE ====================
  renderEarnPage() {
    return `
      <div class="page-section">
        <h2 class="page-title">Earnings Overview</h2>
        <div id="earnContent"><div class="empty-state"><div class="spinner"></div><p>Loading...</p></div></div>
      </div>`;
  },

  async loadEarnContent() {
    const container = document.getElementById('earnContent');
    if (!container) return;
    try {
      const profile = await this.api('/user/profile');
      const di = profile.dailyIncome;
      container.innerHTML = `
        <div class="earn-card">
          <h4>Daily Income Breakdown</h4>
          ${Object.entries(di).map(([k,v]) => `
            <div class="earn-row">
              <span class="label">${k.charAt(0).toUpperCase() + k.slice(1)}</span>
              <span class="value"><span class="usdt-icon">T</span> ${v.toFixed(2)}</span>
            </div>`).join('')}
        </div>
        <div class="earn-card">
          <h4>Summary</h4>
          <div class="earn-row"><span class="label">Total Income</span><span class="value">${profile.totalIncome.toFixed(2)} USDT</span></div>
          <div class="earn-row"><span class="label">Wallet Balance</span><span class="value">${profile.walletBalance.toFixed(2)} USDT</span></div>
          <div class="earn-row"><span class="label">Level</span><span class="value">${profile.level}</span></div>
          <div class="earn-row"><span class="label">Points</span><span class="value">${profile.points}</span></div>
        </div>`;
    } catch (e) { container.innerHTML = '<div class="empty-state"><p>Failed to load</p></div>'; }
  },

  // ==================== RESERVE PAGE ====================
  renderReservePage() {
    return `
      <div class="page-section">
        <h2 class="page-title">Reserve</h2>
        <div id="reserveStats"></div>
        <div class="tabs" style="margin-top:16px;">
          <button class="tab-btn active" data-rtab="todays">Today's</button>
          <button class="tab-btn" data-rtab="reserve">Reserve</button>
          <button class="tab-btn" data-rtab="rcollection">Collection</button>
        </div>
        <div id="reserveContent"><div class="empty-state"><div class="spinner"></div><p>Loading...</p></div></div>
      </div>`;
  },

  async loadReserveContent(tab = 'todays') {
    const container = document.getElementById('reserveContent');
    const statsEl = document.getElementById('reserveStats');
    if (!container) return;
    try {
      const data = await this.api('/reserve/orders');
      if (statsEl) {
        statsEl.innerHTML = `
          <div class="stats-row">
            <div class="stat-card"><div class="stat-card-label">Today's Earnings</div><div class="stat-card-value">${data.todayEarnings.toFixed(2)}</div></div>
            <div class="stat-card"><div class="stat-card-label">Cumulative Income</div><div class="stat-card-value">${data.cumulativeIncome.toFixed(8)}</div></div>
          </div>
          <div class="stats-row">
            <div class="stat-card stat-card-sm"><div class="stat-card-label">Reservation Range</div><div class="stat-card-value">${data.reservationRange}</div></div>
            <div class="stat-card stat-card-sm"><div class="stat-card-label">Wallet Balance</div><div class="stat-card-value">${data.walletBalance.toFixed(2)}</div></div>
            <div class="stat-card stat-card-sm"><div class="stat-card-label">Balance for Reservation</div><div class="stat-card-value">${data.balanceForReservation}</div></div>
          </div>`;
      }

      if (tab === 'todays') {
        const today = data.orders.filter(o => new Date(o.reservationDate).toDateString() === new Date().toDateString());
        if (today.length === 0) {
          container.innerHTML = '<div class="empty-state"><p>No orders today</p></div>';
        } else {
          container.innerHTML = today.map(o => this.renderOrderCard(o)).join('');
        }
      } else if (tab === 'reserve') {
        container.innerHTML = `
          <div class="dark-form-group">
            <label class="dark-form-label">Reservation Amount (50 - 2000 USDT)</label>
            <div style="display:flex;gap:10px;">
              <input type="number" class="dark-form-input" id="reserveAmount" placeholder="Enter amount" min="50" max="2000">
              <button class="btn-all" onclick="document.getElementById('reserveAmount').value='1000'">All</button>
            </div>
          </div>
          <button class="btn-submit btn-submit-primary" onclick="App.makeReservation()">Reserve Now</button>`;
      } else {
        container.innerHTML = data.orders.length === 0 ?
          '<div class="empty-state"><p>No orders yet</p></div>' :
          data.orders.map(o => this.renderOrderCard(o)).join('');
      }
    } catch (e) { container.innerHTML = '<div class="empty-state"><p>Failed to load</p></div>'; }
  },

  renderOrderCard(o) {
    const statusClass = o.status === 'Won' ? 'won' : 'not-won';
    return `
      <div class="order-card">
        <div class="order-header">
          <div class="order-number">Order Number:<span>${o.orderNumber}</span></div>
          <span class="order-status ${statusClass}">${o.status}</span>
        </div>
        <div class="order-detail">Reservation Date: ${new Date(o.reservationDate).toLocaleString()}</div>
        <div class="order-detail">Reservation Amount: <strong><span class="usdt-icon">T</span> ${o.amount}</strong></div>
      </div>`;
  },

  async makeReservation() {
    const amount = parseFloat(document.getElementById('reserveAmount')?.value);
    if (!amount || amount < 50 || amount > 2000) { this.toast('Amount must be between 50 and 2000'); return; }
    try {
      const order = await this.api('/reserve/orders', { method: 'POST', body: JSON.stringify({ amount }) });
      this.toast(order.status === 'Won' ? `Won! +${order.reward} USDT` : 'Not Won this time', order.status === 'Won' ? 'success' : 'error');
      this.loadReserveContent('todays');
      document.querySelectorAll('[data-rtab]').forEach(b => b.classList.remove('active'));
      document.querySelector('[data-rtab="todays"]')?.classList.add('active');
    } catch (e) { this.toast(e.message); }
  },

  // ==================== ASSETS PAGE ====================
  renderAssetsPage() {
    return `
      <div class="page-section">
        <div id="assetsContent"><div class="empty-state"><div class="spinner"></div><p>Loading...</p></div></div>
      </div>`;
  },

  async loadAssetsContent() {
    const container = document.getElementById('assetsContent');
    if (!container) return;
    try {
      const data = await this.api('/assets');
      container.innerHTML = `
        <div class="assets-header">
          <div class="assets-label">My Balance(USDT)</div>
          <div class="assets-balance">${data.balance.toFixed(8)}</div>
          <div class="assets-revenue">
            <div class="assets-revenue-item">
              <div class="val"><span class="usdt-icon">T</span> ${data.totalRevenue.toFixed(8)}</div>
              <div class="lbl">Total Revenue</div>
            </div>
            <div class="assets-revenue-divider"></div>
            <div class="assets-revenue-item">
              <div class="val">${data.totalWithdrawn.toFixed(0)}</div>
              <div class="lbl">Withdrawn</div>
            </div>
            <div class="assets-revenue-divider"></div>
            <div class="assets-revenue-item">
              <div class="val">${data.notWithdrawn.toFixed(0)}</div>
              <div class="lbl">Not Withdrawn</div>
            </div>
          </div>
        </div>
        <div class="section-card" style="margin:0;">
          <div class="section-card-title" style="display:flex;justify-content:space-between;align-items:center;">
            History Record <span style="color:var(--primary);cursor:pointer;">&#10095;</span>
          </div>
          ${data.history.length === 0 ? '<div class="empty-state"><p>No history</p></div>' :
            data.history.map(h => `
              <div class="history-item">
                <div class="history-left">
                  <h4>${h.type}</h4>
                  <p>${new Date(h.date).toLocaleString()}</p>
                </div>
                <div class="history-right">
                  <div class="history-amount ${h.amount > 0 ? 'positive' : 'negative'}">${h.amount > 0 ? '+' : ''}${h.amount}</div>
                  <div class="history-status">${h.status}</div>
                </div>
              </div>`).join('')}
        </div>`;
    } catch (e) { container.innerHTML = '<div class="empty-state"><p>Failed to load</p></div>'; }
  },

  // ==================== MY / PROFILE PAGE ====================
  renderMyPage() {
    return `<div id="myPageContent"><div class="empty-state"><div class="spinner"></div><p>Loading...</p></div></div>`;
  },

  async loadMyPage() {
    const container = document.getElementById('myPageContent');
    if (!container) return;
    try {
      const profile = await this.api('/user/profile');
      const di = profile.dailyIncome;
      container.innerHTML = `
        <div class="profile-header" style="position:relative;">
          <div class="profile-avatar">${profile.avatar ? `<img src="${profile.avatar}">` : profile.username.charAt(0).toUpperCase()}</div>
          <div class="profile-info">
            <h3>${profile.username} &#128065;</h3>
            <div class="profile-uid">UID: ${profile.uid} <button onclick="navigator.clipboard.writeText('${profile.uid}');App.toast('Copied!','success')" style="background:none;border:none;color:var(--text-muted);cursor:pointer;">&#128203;</button></div>
            <div class="profile-badges">
              <span class="badge badge-level">Level ${profile.level}</span>
              <span class="badge badge-points">${profile.points} Points &#10095;</span>
            </div>
          </div>
        </div>
        <div class="wallet-boxes">
          <div class="wallet-box">
            <div class="wallet-box-label">Wallet Balance</div>
            <div class="wallet-box-value"><span class="usdt-icon">T</span> ${profile.walletBalance.toFixed(2)}</div>
          </div>
          <div class="wallet-box">
            <div class="wallet-box-label">Wallet Balance</div>
            <div class="wallet-box-value">&#127760; ${profile.walletBalanceMLK || 0}</div>
          </div>
        </div>
        <div class="section-card">
          <table class="income-table">
            <thead><tr><th></th><th>Daily income</th><th>Total income</th></tr></thead>
            <tbody>
              ${Object.entries(di).map(([k,v]) => `
                <tr>
                  <td>${k.charAt(0).toUpperCase() + k.slice(1)}</td>
                  <td><span class="usdt-icon">T</span> ${v.toFixed(0)}</td>
                  <td><span class="usdt-icon">T</span> ${v.toFixed(0)}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
        <div class="section-card">
          <div class="section-card-title">My Team</div>
          <div class="orders-grid" style="margin-bottom:16px;">
            <div class="orders-grid-item"><div class="num">0</div><div class="label">Community rewards</div></div>
            <div class="orders-grid-item"><div class="num">0</div><div class="label">Valid Members</div></div>
            <div class="orders-grid-item"><div class="num">0</div><div class="label">A enthusiast</div></div>
            <div class="orders-grid-item"><div class="num">0</div><div class="label">B+C enthusiasts</div></div>
          </div>
          <div class="action-grid">
            <button class="action-item" onclick="App.navigate('team')"><div class="action-icon">&#128101;</div><div class="action-label">Community enthusiasts</div></button>
            <button class="action-item" onclick="App.navigate('team')"><div class="action-icon">&#127942;</div><div class="action-label">Community contributions</div></button>
            <button class="action-item" onclick="App.navigate('team')"><div class="action-icon">&#128203;</div><div class="action-label">Community orders</div></button>
            <button class="action-item" onclick="App.navigate('team')"><div class="action-icon">&#128279;</div><div class="action-label">Referral</div></button>
          </div>
        </div>
        <div class="section-card">
          <div class="section-card-title" style="display:flex;justify-content:space-between;">My Orders <span style="color:var(--text-muted);font-weight:400;font-size:0.85rem;cursor:pointer;" onclick="App.navigate('details')">Check Orders &#10095;</span></div>
          <div class="orders-grid" style="margin-bottom:16px;">
            <div class="orders-grid-item"><div class="num">0</div><div class="label">Orders</div></div>
            <div class="orders-grid-item"><div class="num">0</div><div class="label">Processing</div></div>
            <div class="orders-grid-item"><div class="num">0</div><div class="label">Bought</div></div>
            <div class="orders-grid-item"><div class="num">0</div><div class="label">Sold</div></div>
          </div>
          <div class="action-grid">
            <button class="action-item" onclick="App.navigate('locked-savings')"><div class="action-icon">&#128274;</div><div class="action-label">Locked Savings</div></button>
            <button class="action-item" onclick="App.navigate('details')"><div class="action-icon">&#128203;</div><div class="action-label">Details</div></button>
            <button class="action-item" onclick="App.navigate('deposit')"><div class="action-icon">&#128179;</div><div class="action-label">Deposit</div></button>
            <button class="action-item" onclick="App.navigate('withdraw')"><div class="action-icon">&#128181;</div><div class="action-label">Withdraw</div></button>
          </div>
        </div>
        <div class="section-card">
          <div class="section-card-title">Common Functions</div>
          <div class="action-grid" style="grid-template-columns:repeat(3,1fr);">
            <button class="action-item" onclick="App.navigate('settings')"><div class="action-icon">&#9881;</div><div class="action-label">Settings</div></button>
            <button class="action-item" onclick="App.navigate('mint')"><div class="action-icon">&#127912;</div><div class="action-label">Mint</div></button>
            <button class="action-item" onclick="App.navigate('collection')"><div class="action-icon">&#11088;</div><div class="action-label">Collection</div></button>
          </div>
        </div>`;
    } catch (e) { container.innerHTML = '<div class="empty-state"><p>Failed to load</p></div>'; }
  },

  // ==================== ANNOUNCEMENTS ====================
  renderAnnouncementsPage() {
    return `
      <div class="page-section">
        <h2 class="page-title">Announcement</h2>
        <div id="announcementsList"><div class="empty-state"><div class="spinner"></div><p>Loading...</p></div></div>
      </div>`;
  },

  async loadAnnouncements() {
    const container = document.getElementById('announcementsList');
    if (!container) return;
    try {
      const data = await this.api('/announcements');
      if (data.length === 0) {
        container.innerHTML = '<div class="empty-state"><p>No announcements yet</p></div>';
        return;
      }
      container.innerHTML = data.map(a => `
        <div class="announcement-card" onclick="App.navigate('announcement-detail',{id:'${a.id}'})">
          <div class="announcement-text">
            <h4>${a.title}</h4>
            <span class="announcement-badge">${a.category}</span>
            <div class="announcement-date">${a.date}</div>
          </div>
          ${a.image ? `<div class="announcement-img"><img src="${a.image}" alt=""></div>` : ''}
        </div>`).join('');
    } catch (e) { container.innerHTML = '<div class="empty-state"><p>Failed to load</p></div>'; }
  },

  renderAnnouncementDetailPage() {
    return `<div class="announcement-detail" id="announcementDetail"><div class="empty-state"><div class="spinner"></div><p>Loading...</p></div></div>`;
  },

  async loadAnnouncementDetail() {
    const container = document.getElementById('announcementDetail');
    if (!container) return;
    const id = this.pageData?.id || window.location.hash.split('/').pop();
    try {
      const a = await this.api(`/announcements/${id}`);
      container.innerHTML = `
        <button class="announcement-detail-back" onclick="App.navigate('announcements')">&#10094; Back</button>
        <h2>${a.title}</h2>
        <div class="date">${a.date}</div>
        ${a.image ? `<div class="detail-img"><img src="${a.image}" alt=""></div>` : ''}
        <div class="detail-body">${a.content}</div>`;
    } catch (e) { container.innerHTML = '<div class="empty-state"><p>Announcement not found</p></div>'; }
  },

  // ==================== WITHDRAW ====================
  renderWithdrawPage() {
    return `
      <div class="form-page">
        <button class="form-page-back" onclick="App.navigate('my')">&#10094; Back</button>
        <h2 class="page-title">Withdraw</h2>
        <div id="withdrawContent"><div class="empty-state"><div class="spinner"></div><p>Loading...</p></div></div>
      </div>`;
  },

  async loadWithdrawContent() {
    const container = document.getElementById('withdrawContent');
    if (!container) return;
    try {
      const profile = await this.api('/user/profile');
      container.innerHTML = `
        <div class="dark-form-group">
          <label class="dark-form-label">Amount (USDT)</label>
          <div style="display:flex;gap:10px;">
            <input type="number" class="dark-form-input" id="withdrawAmount" placeholder="Enter amount">
            <button class="btn-all" onclick="document.getElementById('withdrawAmount').value='${Math.floor(profile.walletBalance)}'">All</button>
          </div>
        </div>
        <div class="form-row"><span class="form-row-label">Available Balance</span><span class="form-row-value">${profile.walletBalance.toFixed(8)}</span></div>
        <div class="form-row"><span class="form-row-label">Min Withdrawal</span><span class="form-row-value">10 USDT</span></div>
        <div class="form-row"><span class="form-row-label">Fee</span><span class="form-row-value">4%</span></div>
        <div class="form-row"><span class="form-row-label">Tax</span><span class="form-row-value">0</span></div>
        <div class="form-row"><span class="form-row-label">Wallet (TRC20)</span><span class="form-row-value">${profile.walletAddress.trc20 || 'Not set'}</span></div>
        <div class="form-hint">1. The second withdrawal can only be initiated after the first withdrawal reaches the account.</div>
        <div class="form-hint">2. Withdrawal will be processed within 72 hours.</div>
        <div class="form-hint">3. The first withdrawal requires risk control approval. Apply after 72 hours.</div>
        <div style="display:flex;gap:10px;margin-top:20px;">
          <button class="btn-submit btn-submit-outline" style="flex:1;" onclick="App.navigate('my')">Cancel</button>
          <button class="btn-submit btn-submit-primary" style="flex:1;" onclick="App.submitWithdrawal()">Submit</button>
        </div>`;
    } catch (e) { container.innerHTML = '<div class="empty-state"><p>Failed to load</p></div>'; }
  },

  async submitWithdrawal() {
    const amount = parseFloat(document.getElementById('withdrawAmount')?.value);
    if (!amount || amount < 10) { this.toast('Minimum withdrawal is 10 USDT'); return; }
    try {
      await this.api('/withdrawals', { method: 'POST', body: JSON.stringify({ amount, walletType: 'trc20' }) });
      this.toast('Withdrawal submitted!', 'success');
      this.navigate('assets');
    } catch (e) { this.toast(e.message); }
  },

  // ==================== DEPOSIT ====================
  renderDepositPage() {
    return `
      <div class="form-page">
        <button class="form-page-back" onclick="App.navigate('my')">&#10094; Back</button>
        <h2 class="page-title">Deposit</h2>
        <div class="section-card" style="margin:0;">
          <p style="color:var(--text-secondary);font-size:0.9rem;margin-bottom:16px;">To deposit USDT, please contact customer service or use the deposit address provided.</p>
          <div class="dark-form-group">
            <label class="dark-form-label">Amount (USDT)</label>
            <input type="number" class="dark-form-input" id="depositAmount" placeholder="Enter amount">
          </div>
          <button class="btn-submit btn-submit-primary" onclick="App.submitDeposit()">Submit Deposit Request</button>
          <p style="color:var(--text-muted);font-size:0.75rem;margin-top:12px;">Note: Deposits require admin approval before being credited to your account.</p>
        </div>
      </div>`;
  },

  async submitDeposit() {
    const amount = parseFloat(document.getElementById('depositAmount')?.value);
    if (!amount || amount <= 0) { this.toast('Enter a valid amount'); return; }
    try {
      await this.api('/deposits', { method: 'POST', body: JSON.stringify({ amount }) });
      this.toast('Deposit request submitted!', 'success');
      this.navigate('assets');
    } catch (e) { this.toast(e.message); }
  },

  // ==================== SETTINGS ====================
  renderSettingsPage() {
    return `
      <div class="form-page">
        <button class="form-page-back" onclick="App.navigate('my')">&#10094; Back</button>
        <h2 class="page-title">Settings</h2>
        <div id="settingsContent"><div class="empty-state"><div class="spinner"></div><p>Loading...</p></div></div>
      </div>`;
  },

  async loadSettingsContent() {
    const container = document.getElementById('settingsContent');
    if (!container) return;
    try {
      const profile = await this.api('/user/profile');
      container.innerHTML = `
        <h4 style="font-size:0.9rem;color:var(--text-muted);margin-bottom:12px;">Wallet Addresses</h4>
        <div class="settings-item">
          <div class="settings-item-left">
            <h4><span class="usdt-icon">T</span> TRC20(TRX)</h4>
            <p>${profile.walletAddress.trc20 || 'Not set - Click to copy'}</p>
          </div>
          <button class="settings-edit-btn" onclick="App.editWallet('trc20','${profile.walletAddress.trc20 || ''}')">&#9998;</button>
        </div>
        <div class="settings-item">
          <div class="settings-item-left">
            <h4><span class="usdt-icon">T</span> ERC20(ETH)</h4>
            <p>${profile.walletAddress.erc20 || 'Not set - Click to copy'}</p>
          </div>
          <button class="settings-edit-btn" onclick="App.editWallet('erc20','${profile.walletAddress.erc20 || ''}')">&#9998;</button>
        </div>
        <h4 style="font-size:0.9rem;color:var(--text-muted);margin:20px 0 12px;">Account</h4>
        <div class="settings-item">
          <div class="settings-item-left">
            <h4>Username</h4>
            <p>${profile.username}</p>
          </div>
          <button class="settings-edit-btn" onclick="App.editUsername('${profile.username}')">&#9998;</button>
        </div>
        <div class="settings-item">
          <div class="settings-item-left">
            <h4>Email</h4>
            <p>${profile.email}</p>
          </div>
          <span style="color:var(--text-muted);font-size:0.8rem;">&#128274;</span>
        </div>
        <div class="settings-item">
          <div class="settings-item-left">
            <h4>UID</h4>
            <p>${profile.uid}</p>
          </div>
          <button class="settings-edit-btn" onclick="navigator.clipboard.writeText('${profile.uid}');App.toast('Copied!','success')">Copy</button>
        </div>
        <button class="btn-submit" style="background:var(--negative);color:#fff;margin-top:24px;" onclick="App.logout()">Sign Out</button>`;
    } catch (e) { container.innerHTML = '<div class="empty-state"><p>Failed to load</p></div>'; }
  },

  editWallet(type, current) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay active';
    overlay.innerHTML = `
      <div class="modal-box">
        <div class="modal-icon warning">&#9888;</div>
        <h3 class="modal-title">Change ${type.toUpperCase()} Wallet</h3>
        <p class="modal-text">After changing this setting, withdrawal services will be suspended for 2 days 0 hours 0 min 0 s to protect your account.</p>
        <input type="text" class="admin-form-input" id="walletInput" value="${current}" placeholder="Enter wallet address" style="margin-bottom:16px;">
        <div class="modal-actions">
          <button class="modal-btn modal-btn-cancel" onclick="this.closest('.modal-overlay').remove()">Cancel</button>
          <button class="modal-btn modal-btn-confirm" onclick="App.saveWallet('${type}')">Yes</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
  },

  async saveWallet(type) {
    const addr = document.getElementById('walletInput')?.value;
    if (!addr) { this.toast('Enter a wallet address'); return; }
    try {
      const body = {};
      body[type] = addr;
      await this.api('/user/wallet', { method: 'PUT', body: JSON.stringify(body) });
      document.querySelector('.modal-overlay')?.remove();
      this.toast('Wallet updated!', 'success');
      this.loadSettingsContent();
    } catch (e) { this.toast(e.message); }
  },

  editUsername(current) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay active';
    overlay.innerHTML = `
      <div class="modal-box">
        <h3 class="modal-title">Change Username</h3>
        <input type="text" class="admin-form-input" id="usernameInput" value="${current}" style="margin-bottom:16px;">
        <div class="modal-actions">
          <button class="modal-btn modal-btn-cancel" onclick="this.closest('.modal-overlay').remove()">Cancel</button>
          <button class="modal-btn modal-btn-confirm" onclick="App.saveUsername()">Save</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
  },

  async saveUsername() {
    const username = document.getElementById('usernameInput')?.value;
    if (!username) { this.toast('Enter a username'); return; }
    try {
      await this.api('/user/profile', { method: 'PUT', body: JSON.stringify({ username }) });
      document.querySelector('.modal-overlay')?.remove();
      this.toast('Username updated!', 'success');
      this.loadSettingsContent();
    } catch (e) { this.toast(e.message); }
  },

  // ==================== TEAM ====================
  renderTeamPage() {
    return `
      <div class="form-page">
        <button class="form-page-back" onclick="App.navigate('my')">&#10094; Back</button>
        <h2 class="page-title">Team Members</h2>
        <div id="teamContent"><div class="empty-state"><div class="spinner"></div><p>Loading...</p></div></div>
      </div>`;
  },

  async loadTeamContent() {
    const container = document.getElementById('teamContent');
    if (!container) return;
    try {
      const data = await this.api('/user/team');
      const s = data.stats;
      container.innerHTML = `
        <div class="team-stat-group">
          <div class="team-stat-row">
            <div class="team-stat-item"><div class="num">${s.totalRegistered}</div><div class="label">All registered members</div></div>
            <div class="team-stat-item"><div class="num">${s.totalValid}</div><div class="label">All valid members</div></div>
          </div>
        </div>
        <div class="team-stat-group">
          <div class="team-stat-row">
            <div class="team-stat-item"><div class="num">${s.aTier.registered}</div><div class="label">A Tier Registered</div></div>
            <div class="team-stat-item"><div class="num">${s.aTier.valid}</div><div class="label">A-tier valid</div></div>
          </div>
        </div>
        <div class="team-stat-group">
          <div class="team-stat-row">
            <div class="team-stat-item"><div class="num">${s.bTier.registered}</div><div class="label">B Tier Registered</div></div>
            <div class="team-stat-item"><div class="num">${s.bTier.valid}</div><div class="label">B-tier valid</div></div>
          </div>
        </div>
        <div class="team-stat-group">
          <div class="team-stat-row">
            <div class="team-stat-item"><div class="num">${s.cTier.registered}</div><div class="label">C Tier Registered</div></div>
            <div class="team-stat-item"><div class="num">${s.cTier.valid}</div><div class="label">C-tier valid</div></div>
          </div>
        </div>`;
    } catch (e) { container.innerHTML = '<div class="empty-state"><p>Failed to load</p></div>'; }
  },

  // ==================== SUB PAGES ====================
  renderLockedSavingsPage() {
    return `<div class="form-page"><button class="form-page-back" onclick="App.navigate('my')">&#10094; Back</button><h2 class="page-title">Locked Savings</h2><div class="empty-state"><p>No locked savings</p></div></div>`;
  },
  renderDetailsPage() {
    return `<div class="form-page"><button class="form-page-back" onclick="App.navigate('my')">&#10094; Back</button><h2 class="page-title">Details</h2><div class="empty-state"><p>No details yet</p></div></div>`;
  },
  renderMintPage() {
    return `<div class="form-page"><button class="form-page-back" onclick="App.navigate('my')">&#10094; Back</button><h2 class="page-title">Mint NFT</h2><div class="empty-state"><p>Minting coming soon</p></div></div>`;
  },
  renderCollectionPage() {
    return `<div class="form-page"><button class="form-page-back" onclick="App.navigate('my')">&#10094; Back</button><h2 class="page-title">My Collection</h2><div class="empty-state"><p>No items in collection</p></div></div>`;
  },

  // ==================== EVENT BINDING ====================
  bindEvents() {
    // Auth forms
    document.getElementById('loginForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('loginEmail').value;
      const password = document.getElementById('loginPassword').value;
      try {
        const data = await this.api('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
        this.login(data.token, data.user);
      } catch (e) { this.toast(e.message); }
    });

    document.getElementById('signupForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('signupEmail').value;
      const password = document.getElementById('signupPassword').value;
      const confirmPassword = document.getElementById('signupConfirm').value;
      const referralCode = document.getElementById('signupReferral').value;
      try {
        const data = await this.api('/auth/register', { method: 'POST', body: JSON.stringify({ email, password, confirmPassword, referralCode }) });
        this.login(data.token, data.user);
      } catch (e) { this.toast(e.message); }
    });

    document.getElementById('forgotForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('forgotEmail').value;
      const password = document.getElementById('forgotPassword').value;
      const confirmPassword = document.getElementById('forgotConfirm').value;
      try {
        await this.api('/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email, password, confirmPassword }) });
        this.toast('Password reset successfully!', 'success');
        this.navigate('login');
      } catch (e) { this.toast(e.message); }
    });

    // Tab clicks for stake page
    document.querySelectorAll('.tab-btn[data-tab]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn[data-tab]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const tab = btn.dataset.tab;
        const filterMap = { 'stake-tab': 'all', 'polygon-tab': 'polygon', 'art-tab': 'art', 'collectibles-tab': 'collectibles' };
        const activeSubTab = document.querySelector('.sub-tab-btn.active')?.dataset.subtab || 'available';
        this.loadStakeContent(filterMap[tab] || 'all', activeSubTab);
      });
    });

    document.querySelectorAll('.sub-tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.sub-tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const activeTab = document.querySelector('.tab-btn[data-tab].active')?.dataset.tab || 'stake-tab';
        const filterMap = { 'stake-tab': 'all', 'polygon-tab': 'polygon', 'art-tab': 'art', 'collectibles-tab': 'collectibles' };
        this.loadStakeContent(filterMap[activeTab] || 'all', btn.dataset.subtab);
      });
    });

    // Reserve tabs
    document.querySelectorAll('[data-rtab]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('[data-rtab]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.loadReserveContent(btn.dataset.rtab);
      });
    });

    // Load page data
    this.loadPageData();
  },

  async loadPageData() {
    const page = this.currentPage;
    if (page === 'stake') {
      this.loadStakeContent();
      this.loadNFTCards();
    }
    else if (page === 'earn') this.loadEarnContent();
    else if (page === 'reserve') this.loadReserveContent();
    else if (page === 'assets') this.loadAssetsContent();
    else if (page === 'my') this.loadMyPage();
    else if (page === 'announcements') this.loadAnnouncements();
    else if (page === 'announcement-detail') this.loadAnnouncementDetail();
    else if (page === 'withdraw') this.loadWithdrawContent();
    else if (page === 'settings') this.loadSettingsContent();
    else if (page === 'team') this.loadTeamContent();

    // Check for announcements notification
    try {
      const ann = await this.api('/announcements');
      const dot = document.getElementById('notifDot');
      if (dot) dot.style.display = ann.length > 0 ? 'block' : 'none';
    } catch (e) {}
  },

  async loadNFTCards() {
    const container = document.getElementById('nftCardsScroll');
    if (!container) return;
    try {
      const catalog = await this.api('/stakes/catalog');
      container.innerHTML = catalog.map(nft => `
        <div class="nft-mini-card">
          <div class="nft-mini-img" style="background:${nft.color};">&#127912;</div>
          <div class="nft-mini-info">
            <h4>${nft.name}</h4>
            <p>${nft.collection}</p>
          </div>
        </div>`).join('');
    } catch (e) {}
  },
};

// Initialize
App.init();
