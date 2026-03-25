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
