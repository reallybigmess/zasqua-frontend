/**
 * Site Configuration
 *
 * Small Eleventy data module that exposes site-wide values every template
 * can reach through the `site` variable — the display title, the
 * description used as the default meta description, the canonical site
 * URL (overridable in CI via the `SITE_URL` environment variable), the
 * default language, three build-time stamps (ISO timestamp, date, and
 * year), and the current release version.
 *
 * The `version` field drives the footer's link to the matching GitHub
 * release and should be bumped as part of each release cycle so the
 * footer always advertises the live release. The build timestamps freeze
 * the moment the static site was generated, which the footer surfaces as
 * "Última actualización".
 *
 * @version v0.4.0
 */
module.exports = {
  title: "Zasqua",
  description: "Zasqua es la plataforma de consulta de materiales de archivo, libros, revistas e instrumentos de consulta digitalizados y sistematizados por Neogranadina y sus aliados.",
  url: process.env.SITE_URL || "http://localhost:8080",
  language: "es",
  buildTime: new Date().toISOString(),
  buildDate: new Date().toISOString().split('T')[0],
  buildYear: new Date().getFullYear(),
  version: "0.4.0"
};
