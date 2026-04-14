/**
 * Entity Detail Page — Related Descriptions
 *
 * Runs on entity pages, which represent people, corporate bodies, or families
 * that appear as creators or subjects across the archive. The static template
 * renders the entity's ISAAR-style biographical data at build time, but the
 * list of archival descriptions that mention the entity would be too large to
 * bake into every page, so this script fetches that list on demand.
 *
 * It looks for an `#entity-descriptions` container, reads the API URL from the
 * element's `data-api-url` attribute, and calls that endpoint to retrieve the
 * related descriptions. Each result is rendered as a link to the description
 * page using its reference code as the URL slug, with the date expression
 * appended when available. If the fetch fails or the list is empty, a short
 * Spanish-language placeholder is shown instead.
 *
 * @version v0.4.0
 */

document.addEventListener("DOMContentLoaded", function() {
  var container = document.getElementById("entity-descriptions");
  if (!container) return;

  var apiUrl = container.getAttribute("data-api-url");
  if (!apiUrl) return;

  fetch(apiUrl)
    .then(function(res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    })
    .then(function(data) {
      var descriptions = Array.isArray(data) ? data : (data.results || []);
      if (descriptions.length === 0) {
        container.innerHTML = '<p class="text-stone-400 text-sm">No se encontraron documentos relacionados.</p>';
        return;
      }

      var html = '<ul class="detail-list">';
      for (var i = 0; i < descriptions.length; i++) {
        var d = descriptions[i];
        var href = "/" + (d.reference_code || "").replace(/[?#]/g, "") + "/";
        var date = d.date_expression ? " &middot; " + d.date_expression : "";
        html += '<li>';
        html += '<a href="' + href + '" class="text-burgundy hover:text-burgundy-light">' + d.title + "</a>";
        html += '<span class="text-stone-400 text-sm"> ' + d.reference_code + date + "</span>";
        html += '</li>';
      }
      html += '</ul>';
      container.innerHTML = html;
    })
    .catch(function(err) {
      container.innerHTML = '<p class="text-stone-400 text-sm">No se pudieron cargar los documentos relacionados.</p>';
      console.error("entity.js: failed to load descriptions", err);
    });
});
