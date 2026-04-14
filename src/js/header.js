/**
 * Site Header — Mobile Navigation and Browse Dropdown
 *
 * Drives the two interactive pieces of the site header. The first is the
 * hamburger menu on narrow viewports, where the primary navigation collapses
 * behind a toggle button: the script attaches to `.hamburger-toggle` and
 * `.site-nav`, flips a `nav-open` class to show or hide the menu, swaps the
 * Material Symbols glyph between `menu` and `close`, and updates
 * `aria-expanded` so screen readers announce the current state. The menu
 * closes automatically when the user clicks outside the header or presses
 * Escape — standard dismissal patterns that keep keyboard and pointer users
 * on equal footing.
 *
 * The second piece is the Browse dropdown in the primary navigation, which
 * groups the three discovery surfaces (Documentos, Entidades, Lugares) under
 * a single trigger. On desktop the dropdown is revealed with a CSS `:hover`
 * rule, but touch devices need a click handler — so the script also toggles
 * a `dropdown-open` class on `.nav-dropdown` when the trigger is tapped,
 * and dismisses the menu when the user clicks anywhere outside it.
 *
 * @version v0.5.0
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

// Nav dropdown toggle (mobile tap, desktop uses CSS :hover)
(function () {
  var dropdown = document.querySelector('.nav-dropdown');
  var trigger = document.querySelector('.nav-dropdown-trigger');
  if (!dropdown || !trigger) return;

  trigger.addEventListener('click', function (e) {
    e.preventDefault();
    dropdown.classList.toggle('dropdown-open');
  });

  // Close dropdown when clicking outside
  document.addEventListener('click', function (e) {
    if (!e.target.closest('.nav-dropdown')) {
      dropdown.classList.remove('dropdown-open');
    }
  });
})();
