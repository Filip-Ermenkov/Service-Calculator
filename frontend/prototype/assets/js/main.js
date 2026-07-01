/* ============================================================
   BULBAU.LU — Prototype Shared Scripts
   ============================================================ */

document.addEventListener('DOMContentLoaded', function () {

  /* ---- Mobile hamburger menu ---- */
  const menuBtn = document.getElementById('menuBtn');
  const mobileMenu = document.getElementById('mobileMenu');
  if (menuBtn && mobileMenu) {
    menuBtn.addEventListener('click', () => {
      mobileMenu.classList.toggle('open');
      const isOpen = mobileMenu.classList.contains('open');
      menuBtn.setAttribute('aria-expanded', isOpen);
    });
  }

  /* ---- Language switcher (visual only in prototype) ---- */
  document.querySelectorAll('.lang-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.lang-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  /* ---- Contact form (About Us page) ---- */
  const contactForm = document.getElementById('contactForm');
  if (contactForm) {
    contactForm.addEventListener('submit', function (e) {
      e.preventDefault();
      const success = document.getElementById('formSuccess');
      if (success) {
        success.classList.add('show');
        contactForm.reset();
        setTimeout(() => success.classList.remove('show'), 5000);
      }
    });
  }

});
