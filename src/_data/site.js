module.exports = {
  title: "MCM Collection",
  description: "YUCoM's MCM collection in the Zasqua platform.",
  url: process.env.SITE_URL || "http://localhost:8080",
  language: "en",
  buildTime: new Date().toISOString(),
  buildDate: new Date().toISOString().split('T')[0],
  buildYear: new Date().getFullYear(),
  version: "0.4.0",
};
