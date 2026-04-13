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
        container.innerHTML = '<p class="text-stone-400 text-sm">No related documents were found.</p>';
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
      container.innerHTML = '<p class="text-stone-400 text-sm">The related documents could not be loaded.</p>';
      console.error("entity.js: failed to load descriptions", err);
    });
});
