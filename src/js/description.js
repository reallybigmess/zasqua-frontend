/**
 * Description Page Behaviours
 *
 * Powers the interactive controls on a single archival description page — the
 * page a visitor lands on when viewing one document, file, series, or fonds.
 * Two features live here: copy-to-clipboard for the IIIF manifest URL exposed
 * in the reuse panel, and the embedded deep-zoom image viewer.
 *
 * The viewer is TIFY, a self-hosted IIIF viewer bundled under `src/vendor/tify/`.
 * IIIF (International Image Interoperability Framework) is the standard Zasqua
 * uses to serve high-resolution scans as tiled pyramids so the browser only
 * fetches the tiles currently visible. When the page contains a `.desc-viewer`
 * element with a `data-manifest` attribute, this script boots TIFY against that
 * manifest and then injects custom pill-style controls into its header — an
 * expand/contract toggle that widens the viewer within the page, a fullscreen
 * toggle, and a thumbnails button that reuses TIFY's own Pages panel by briefly
 * unhiding its popup so Vue's internal state stays in sync.
 *
 * @version v0.3.0
 */

document.addEventListener("DOMContentLoaded", function() {

  // Copy-to-clipboard for IIIF manifest URL
  var copyBtns = document.querySelectorAll(".reuse-copy-btn");
  for (var i = 0; i < copyBtns.length; i++) {
    copyBtns[i].addEventListener("click", function() {
      var btn = this;
      var url = btn.getAttribute("data-copy-url");
      if (!url) return;
      navigator.clipboard.writeText(url).then(function() {
        var icon = btn.querySelector(".material-symbols-outlined");
        var originalHTML = btn.innerHTML;
        icon.textContent = "check";
        btn.lastChild.textContent = " Copiado";
        setTimeout(function() {
          btn.innerHTML = originalHTML;
        }, 2000);
      });
    });
  }

  // IIIF Viewer (TIFY)
  var viewerEl = document.querySelector(".desc-viewer[data-manifest]");
  if (!viewerEl || typeof Tify === "undefined") return;

  var manifestUrl = viewerEl.getAttribute("data-manifest");

  // Init TIFY
  new Tify({
    container: ".desc-viewer",
    manifestUrl: manifestUrl,
    colorMode: "dark",
    view: null
  });

  // Trigger viewport recalculation after a layout change
  function resetViewport() {
    setTimeout(function() {
      window.dispatchEvent(new Event("resize"));
    }, 200);
  }

  // Wait for TIFY to render, then inject custom controls
  setTimeout(function() {
    var header = viewerEl.querySelector(".tify-header");
    if (!header) return;

    var columns = header.querySelectorAll(".tify-header-column");
    if (columns.length < 3) return;

    // -- Left group (column 1): size toggle buttons --
    var leftBtns = document.createElement("div");
    leftBtns.className = "viewer-left-btns";
    leftBtns.style.cssText = "display: flex; gap: 0.3rem; align-items: center;";

    var expandBtn = document.createElement("button");
    expandBtn.className = "viewer-pill viewer-pill-expand";
    expandBtn.innerHTML = '<span class="material-symbols-outlined">open_in_full</span> Expandir';
    expandBtn.addEventListener("click", function() {
      document.querySelector(".desc-layout").classList.add("viewer-expanded");
      resetViewport();
    });

    var contraerBtn = document.createElement("button");
    contraerBtn.className = "viewer-pill viewer-pill-contraer";
    contraerBtn.innerHTML = '<span class="material-symbols-outlined">close_fullscreen</span> Contraer';
    contraerBtn.addEventListener("click", function() {
      document.querySelector(".desc-layout").classList.remove("viewer-expanded");
      resetViewport();
    });

    var fullscreenBtn = document.createElement("button");
    fullscreenBtn.className = "viewer-pill viewer-pill-fullscreen";
    fullscreenBtn.innerHTML = '<span class="material-symbols-outlined">fullscreen</span> Pantalla completa';
    fullscreenBtn.addEventListener("click", function() {
      if (document.fullscreenElement === viewerEl) {
        document.exitFullscreen();
      } else {
        viewerEl.requestFullscreen();
      }
    });

    leftBtns.appendChild(expandBtn);
    leftBtns.appendChild(contraerBtn);
    leftBtns.appendChild(fullscreenBtn);
    columns[0].appendChild(leftBtns);

    // -- Right group (column 3): Miniaturas --
    var rightBtns = document.createElement("div");
    rightBtns.className = "viewer-right-btns";
    rightBtns.style.cssText = "gap: 0.3rem; align-items: center;";

    var miniBtn = document.createElement("button");
    miniBtn.className = "viewer-pill viewer-pill-mini";
    miniBtn.innerHTML = '<span class="material-symbols-outlined">grid_view</span> Miniaturas';
    miniBtn.addEventListener("click", function() {
      // TIFY's popup is hidden via CSS; temporarily unhide to click the
      // native Pages button, which properly toggles the thumbnails panel
      // through Vue's internal state.
      var popup = viewerEl.querySelector(".tify-header-popup");
      if (!popup) return;
      popup.style.cssText = "display:flex !important; visibility:hidden; position:absolute;";
      var pagesBtn = popup.querySelectorAll(".tify-header-button")[1];
      if (pagesBtn) pagesBtn.click();
      setTimeout(function() { popup.style.cssText = ""; }, 50);
    });

    rightBtns.appendChild(miniBtn);
    columns[2].appendChild(rightBtns);

    // -- Fullscreen label toggle + viewport reset --
    document.addEventListener("fullscreenchange", function() {
      if (document.fullscreenElement === viewerEl) {
        fullscreenBtn.innerHTML = '<span class="material-symbols-outlined">fullscreen_exit</span> Cerrar pantalla completa';
      } else {
        fullscreenBtn.innerHTML = '<span class="material-symbols-outlined">fullscreen</span> Pantalla completa';
      }
      resetViewport();
    });

  }, 1500);

});
