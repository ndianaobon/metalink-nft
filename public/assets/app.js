// Theme Toggle
const themeToggle = document.getElementById('themeToggle');
const html = document.documentElement;

function setTheme(theme) {
  html.setAttribute('data-theme', theme);
  localStorage.setItem('theme', theme);
}

themeToggle.addEventListener('click', () => {
  const current = html.getAttribute('data-theme');
  setTheme(current === 'dark' ? 'light' : 'dark');
});

const saved = localStorage.getItem('theme');
if (saved) setTheme(saved);

// Mobile Menu
const mobileMenuBtn = document.getElementById('mobileMenuBtn');
const navLinks = document.getElementById('navLinks');

mobileMenuBtn.addEventListener('click', () => {
  navLinks.classList.toggle('active');
  mobileMenuBtn.classList.toggle('active');
});

navLinks.querySelectorAll('a').forEach(link => {
  link.addEventListener('click', () => {
    navLinks.classList.remove('active');
    mobileMenuBtn.classList.remove('active');
  });
});

// Wallet Modal
const walletModal = document.getElementById('walletModal');
const modalClose = document.getElementById('modalClose');

function openModal() { walletModal.classList.add('active'); }
function closeModal() { walletModal.classList.remove('active'); }

document.getElementById('connectWalletBtn').addEventListener('click', openModal);
document.getElementById('heroConnectBtn').addEventListener('click', openModal);
modalClose.addEventListener('click', closeModal);
walletModal.addEventListener('click', (e) => { if (e.target === walletModal) closeModal(); });

document.querySelectorAll('.wallet-option').forEach(btn => {
  btn.addEventListener('click', () => {
    const name = btn.querySelector('span').textContent;
    btn.style.borderColor = '#4F46E5';
    btn.innerHTML = `<svg width="32" height="32" viewBox="0 0 32 32" fill="none"><circle cx="16" cy="16" r="12" stroke="#4F46E5" stroke-width="2" stroke-dasharray="6 4"><animateTransform attributeName="transform" type="rotate" from="0 16 16" to="360 16 16" dur="1s" repeatCount="indefinite"/></circle></svg><span>Connecting to ${name}...</span>`;
    setTimeout(() => {
      btn.innerHTML = `<svg width="32" height="32" viewBox="0 0 32 32" fill="none"><circle cx="16" cy="16" r="12" fill="#14B8A6"/><path d="M11 16l3 3 7-7" stroke="white" stroke-width="2" fill="none"/></svg><span>Connected!</span>`;
      setTimeout(closeModal, 1200);
    }, 2000);
  });
});

// Scroll Reveal
const observer = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.classList.add('visible');
    }
  });
}, { threshold: 0.1, rootMargin: '0px 0px -40px 0px' });

document.querySelectorAll('.reveal').forEach(el => observer.observe(el));

// Navbar scroll effect
let lastScroll = 0;
const navbar = document.getElementById('navbar');
window.addEventListener('scroll', () => {
  const current = window.scrollY;
  if (current > 100) {
    navbar.style.borderBottomColor = 'var(--border)';
  } else {
    navbar.style.borderBottomColor = 'transparent';
  }
  lastScroll = current;
});

// Hero Canvas - Subtle geometric animation
const canvas = document.getElementById('heroCanvas');
const ctx = canvas.getContext('2d');

function resizeCanvas() {
  canvas.width = canvas.offsetWidth * window.devicePixelRatio;
  canvas.height = canvas.offsetHeight * window.devicePixelRatio;
  ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
}
resizeCanvas();
window.addEventListener('resize', resizeCanvas);

const particles = [];
const particleCount = 40;

for (let i = 0; i < particleCount; i++) {
  particles.push({
    x: Math.random() * canvas.offsetWidth,
    y: Math.random() * canvas.offsetHeight,
    size: Math.random() * 2 + 1,
    speedX: (Math.random() - 0.5) * 0.3,
    speedY: (Math.random() - 0.5) * 0.3,
    opacity: Math.random() * 0.3 + 0.1,
  });
}

function drawParticles() {
  ctx.clearRect(0, 0, canvas.offsetWidth, canvas.offsetHeight);
  const w = canvas.offsetWidth;
  const h = canvas.offsetHeight;

  particles.forEach((p, i) => {
    p.x += p.speedX;
    p.y += p.speedY;
    if (p.x < 0) p.x = w;
    if (p.x > w) p.x = 0;
    if (p.y < 0) p.y = h;
    if (p.y > h) p.y = 0;

    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(79, 70, 229, ${p.opacity})`;
    ctx.fill();

    particles.forEach((p2, j) => {
      if (j <= i) return;
      const dx = p.x - p2.x;
      const dy = p.y - p2.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 150) {
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.strokeStyle = `rgba(79, 70, 229, ${0.06 * (1 - dist / 150)})`;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    });
  });

  requestAnimationFrame(drawParticles);
}
drawParticles();
