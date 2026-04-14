/**
 * Site Header — Mobile Navigation Toggle
 *
 * Drives the hamburger menu in the site header on narrow viewports, where the
 * primary navigation collapses behind a toggle button. The script runs on every
 * page, attaches to `.hamburger-toggle` and `.site-nav`, and flips a `nav-open`
 * class to show or hide the menu. It also swaps the Material Symbols glyph
 * between `menu` and `close` and updates `aria-expanded` so screen readers
 * announce the current state.
 *
 * The menu closes automatically when the user clicks outside the header or
 * presses the Escape key — standard dismissal patterns that keep keyboard and
 * pointer users on equal footing.
 *
 * @version v0.1.0
 */

// Hamburger menu toggle
(function () {
  const btn = document.querySelector('.hamburger-toggle');
  const nav = document.querySelector('.site-nav');
  if (!btn || !nav) return;

  const icon = btn.querySelector('.material-symbols-outlined');

  function open() {
    nav.classList.add('nav-open');
    btn.setAttribute('aria-expanded', 'true');
    if (icon) icon.textContent = 'close';
  }

  function close() {
    nav.classList.remove('nav-open');
    btn.setAttribute('aria-expanded', 'false');
    if (icon) icon.textContent = 'menu';
  }

  btn.addEventListener('click', function () {
    nav.classList.contains('nav-open') ? close() : open();
  });

  // Close on click outside header
  document.addEventListener('click', function (e) {
    if (nav.classList.contains('nav-open') && !e.target.closest('.site-header')) {
      close();
    }
  });

  // Close on Escape
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && nav.classList.contains('nav-open')) {
      close();
    }
  });
})();
