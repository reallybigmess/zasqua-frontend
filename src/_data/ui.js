/**
 * UI Strings
 *
 * Central dictionary of user-facing Spanish text used throughout the
 * site — navigation labels, the 404 page, breadcrumbs, search page
 * copy and sort options, facet labels, ISAD(G) description level names
 * (in singular and plural), descriptive headings for each section of the
 * description page, ISAAR role names, individual metadata field labels,
 * repository page copy, and footer credits and copyright.
 *
 * Every template reads through the `ui` variable so wording changes flow
 * from a single source of truth. The description levels (fondo,
 * subfondo, serie, subserie, expediente, unidad documental, colección,
 * sección, tomo) and the field labels follow ISAD(G) and the
 * platform-wide terminology agreed with the archival partners. The
 * plural level table includes a few container types (caja, carpeta,
 * legajo, tomo) extracted from titles so child counts read naturally.
 *
 * All strings are in Colombian Spanish; user-facing English copy is not
 * currently rendered from this file.
 *
 * @version v0.4.0
 */
module.exports = {
  // Navigation
  nav: {
    home: "Inicio",
    search: "Buscar",
    about: "Acerca",
    catalogacion: "Catalogación",
    browse: "Explorar"
  },

  // Error pages
  error404: {
    title: "Página no encontrada",
    message: "La página solicitada no existe o fue trasladada.",
    home: "Volver al inicio",
    search: "Buscar en el catálogo"
  },

  // Breadcrumbs
  breadcrumb: {
    home: "Inicio"
  },

  // Search page
  search: {
    placeholder: "Buscar en el catálogo...",
    button: "Buscar",
    results: "{count} resultados",
    noResults: "No se encontraron resultados",
    clearFilters: "Limpiar filtros",
    filtersHeader: "Filtros",
    sidebarHeading: "Filtrar por:",
    sidebarSearch: "Buscar en resultados...",
    sort: {
      label: "Ordenar por",
      relevance: "Relevancia",
      dateAsc: "Fecha (más antiguo)",
      dateDesc: "Fecha (más reciente)",
      titleAsc: "Título (A-Z)"
    },
    filterToggle: "Filtros",
    noResultsSuggestion: "Intenta limpiar los filtros o modificar la consulta.",
    dateFrom: "Desde",
    dateTo: "Hasta"
  },

  // Facet labels
  facets: {
    repository: "Repositorio",
    level: "Nivel de descripción",
    dateRange: "Rango de fechas",
    hasDigital: "Copia digitalizada disponible",
    country: "País"
  },

  // Description levels (singular)
  levels: {
    fonds: "Fondo",
    subfonds: "Subfondo",
    series: "Serie",
    subseries: "Subserie",
    file: "Expediente",
    item: "Unidad documental",
    collection: "Colección",
    section: "Sección",
    volume: "Tomo"
  },

  // Description levels (plural, for child counts)
  levelsPlural: {
    fonds: "fondos",
    subfonds: "subfondos",
    series: "series",
    subseries: "subseries",
    file: "expedientes",
    item: "documentos",
    collection: "colecciones",
    section: "secciones",
    volume: "tomos",
    // Container types (from titles)
    caja: "cajas",
    carpeta: "carpetas",
    legajo: "legajos",
    tomo: "tomos"
  },

  // Description page
  description: {
    metadataHeader: "Descripción",
    bibliographicHeader: "Información bibliográfica",
    accessConditionsHeader: "Condiciones de acceso",
    relatedMaterialsHeader: "Materiales relacionados",
    notesHeader: "Notas",
    entitiesHeader: "Personas y entidades relacionadas",
    placesHeader: "Lugares",
    reuseHeader: "Reutilización",
    metsLabel: "Metadatos METS",
    iiifLabel: "Manifiesto IIIF",
    childrenHeader: "Contenido",
    previous: "Anterior",
    next: "Siguiente",
    notDigitised: "Material no digitalizado",
    notDigitisedText: "Este documento no cuenta con copia digital. Para consultarlo, diríjase al repositorio de origen.",
    externalDigital: "Copia digital disponible",
    externalDigitalText: "Este documento ha sido digitalizado y puede consultarse en el repositorio de la institución custodia.",
    viewAllChildren: "Ver los {count} documentos"
  },

  // Entity roles
  roles: {
    creator: "Productor",
    contributor: "Colaborador",
    publisher: "Editor",
    subject: "Materia",
    mentioned: "Mencionado"
  },

  // Metadata field labels
  fields: {
    referenceCode: "Código de referencia",
    title: "Título",
    date: "Fecha",
    extent: "Extensión",
    scopeContent: "Alcance y contenido",
    arrangement: "Signatura original",
    accessConditions: "Condiciones de acceso",
    reproductionConditions: "Condiciones de reproducción",
    language: "Idioma",
    repository: "Repositorio",
    locationOfOriginals: "Localización de los originales",
    locationOfCopies: "Existencia y localización de copias",
    relatedMaterials: "Materiales relacionados",
    findingAids: "Instrumentos de consulta",
    notes: "Notas",
    // Bibliographic
    publicationTitle: "Publicación",
    imprint: "Pie de imprenta",
    editionStatement: "Edición",
    seriesStatement: "Serie",
    uniformTitle: "Título uniforme",
    sectionTitle: "Sección",
    pages: "Páginas",
    country: "País"
  },

  // Repository page
  repository: {
    itemsCount: "documentos",
    dateRange: "Fechas extremas",
    collections: "Fondos y colecciones",
    noCollections: "No hay colecciones disponibles"
  },

  // Footer
  footer: {
    credits: "Desarrollado por Neogranadina con el apoyo de la Universidad de California, Santa Bárbara",
    copyright: "© {year} Fundación Histórica Neogranadina"
  },

  // General
  general: {
    loading: "Cargando...",
    error: "Ha ocurrido un error",
    viewMore: "Ver más",
    back: "Volver"
  }
};
