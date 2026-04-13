module.exports = {
  // Navigation
  nav: {
    home: "Home",
    search: "Search",
    about: "About",
    catalogacion: "Cataloging",
    browse: "Browse"
  },

  // Error pages
  error404: {
    title: "Page not found",
    message: "The requested page does not exist or has been moved.",
    home: "Return Home",
    search: "Search the catalog"
  },

  // Breadcrumbs
  breadcrumb: {
    home: "Home"
  },

  // Search page
  search: {
    placeholder: "Search the catalog...",
    button: "Search",
    results: "{count} results",
    noResults: "No results found",
    clearFilters: "Clear filters",
    filtersHeader: "Filters",
    sidebarHeading: "Filter for:",
    sidebarSearch: "Search within results...",
    sort: {
      label: "Order by",
      relevance: "Relevance",
      dateAsc: "Date (oldest)",
      dateDesc: "Date (recent)",
      titleAsc: "Title (A-Z)"
    },
    filterToggle: "Filters",
    noResultsSuggestion: "Try clearing the filters or modifying your query.",
    dateFrom: "From",
    dateTo: "To"
  },

  // Facet labels
  facets: {
    repository: "Repository",
    level: "Level of description",
    dateRange: "Range of dates",
    hasDigital: "Digital object available",
    country: "Country"
  },

  // Description levels (singular)
  levels: {
    fonds: "Fond",
    subfonds: "Subfond",
    series: "Series",
    subseries: "Subseries",
    file: "File",
    item: "Item",
    collection: "Collection",
    section: "Section",
    volume: "Volume"
  },

  // Description levels (plural, for child counts)
  levelsPlural: {
    fonds: "fonds",
    subfonds: "subfonds",
    series: "series",
    subseries: "subseries",
    file: "files",
    item: "items",
    collection: "collections",
    section: "sections",
    volume: "volumes",
    // Container types (from titles)
    caja: "boxes",
    carpeta: "folders",
    legajo: "files",
    tomo: "volumes"
  },

  // Description page
  description: {
    metadataHeader: "Description",
    bibliographicHeader: "Bibliographic information",
    accessConditionsHeader: "Access conditions",
    relatedMaterialsHeader: "Related materials",
    notesHeader: "Notes",
    entitiesHeader: "Related people and entities",
    placesHeader: "Places",
    reuseHeader: "Reuse",
    metsLabel: "METS Manifest",
    iiifLabel: "IIIF Manifest",
    childrenHeader: "Contents",
    previous: "Previous",
    next: "Next",
    notDigitised: "Material not digitized",
    notDigitisedText: "This document doesn't have a digital version available. To view it, go to the source repository.",
    externalDigital: "Digital version available",
    externalDigitalText: "This document has a digital version available in the custodial institution's repository.",
    viewAllChildren: "View the {count} documents"
  },

  // Entity roles
  roles: {
    creator: "Creator",
    contributor: "Contributor",
    publisher: "Publisher",
    subject: "Subject",
    mentioned: "Mentioned"
  },

  // Metadata field labels
  fields: {
    referenceCode: "Reference Code",
    title: "Title",
    date: "Date",
    extent: "Extent",
    scopeContent: "Scope and Content",
    arrangement: "Arrangement",
    accessConditions: "Access Conditions",
    reproductionConditions: "Reproduction Conditions",
    language: "Language",
    repository: "Repository",
    locationOfOriginals: "Location of originals",
    locationOfCopies: "Location of copies",
    relatedMaterials: "Related materials",
    findingAids: "Finding aids",
    notes: "Notes",
    // Bibliographic
    publicationTitle: "Publication",
    imprint: "Imprint",
    editionStatement: "Edition",
    seriesStatement: "Series",
    uniformTitle: "Uniform Title",
    sectionTitle: "Section",
    pages: "Pages",
    country: "Country"
  },

  // Repository page
  repository: {
    itemsCount: "items",
    dateRange: "Date range",
    collections: "Collections",
    noCollections: "No collections available"
  },

  // Footer
  footer: {
    credits: "Developed by Neogranadina with help from the University of California, Santa Bárbara",
    copyright: "© {year} Fundación Histórica Neogranadina"

  },

  // General
  general: {
    loading: "Loading...",
    error: "An error has occurred",
    viewMore: "View more",
    back: "Back"
  }
};
