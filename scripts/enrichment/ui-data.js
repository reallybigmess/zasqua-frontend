/**
 * UI String Table (Colombian Spanish)
 *
 * Canonical Colombian-Spanish labels for the navigation, breadcrumbs,
 * search surface, explorer surfaces, common buttons, role vocabulary
 * for entity-document relationships, description-level labels, and
 * error messages. Read by `scripts/generate-content.js` (to emit
 * role labels onto enriched description records) and by Hugo
 * templates via the `data/ui.json` handoff generated at build time.
 *
 * All strings are authored here and nowhere else — a single edit
 * point keeps UI copy consistent across the static build, the
 * enrichment layer, and the three client-side explorers.
 *
 * @version v1.0.0
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

  // Entity roles (complete 29-role vocabulary — )
  roles: {
    // Core roles (existing 5)
    creator: "Productor",
    contributor: "Colaborador",
    publisher: "Editor",
    subject: "Materia",
    mentioned: "Mencionado",
    // Extended roles from entity_links.json
    sender: "Remitente",
    recipient: "Destinatario",
    defendant: "Demandado",
    plaintiff: "Demandante",
    witness: "Testigo",
    official: "Oficial",
    scribe: "Escribano",
    notary: "Notario",
    judge: "Juez",
    author: "Autor",
    buyer: "Comprador",
    seller: "Vendedor",
    guarantor: "Fiador",
    petitioner: "Solicitante",
    appellant: "Apelante",
    executor: "Albacea",
    guardian: "Tutor",
    attorney: "Apoderado",
    interpreter: "Intérprete",
    appraiser: "Tasador",
    lessee: "Arrendatario",
    lessor: "Arrendador",
    debtor: "Deudor",
    creditor: "Acreedor"
  },

  // Entity authority records (ISAAR CPF)
  entity: {
    // Type labels (ISAAR CPF — )
    types: {
      person: "Persona",
      corporate_body: "Entidad corporativa",
      corporate: "Entidad corporativa",
      family: "Familia"
    },
    // Section headers (ISAAR CPF areas — )
    sections: {
      identification: "Identificación",
      functions: "Cargos y funciones",
      history: "Historia",
      relations: "Relaciones",
      authorityLinks: "Identificadores externos",
      control: "Control",
      reuse: "Reutilización",
      sources: "Fuentes"
    },
    // Field labels
    fields: {
      entityCode: "Identificador Neogranadina",
      name: "Nombre",
      normalizedName: "Nombre normalizado",
      type: "Tipo",
      datesOfExistence: "Fechas de existencia",
      primaryFunction: "Función principal",
      nameVariants: "Variantes del nombre",
      history: "Historia",
      roleInDocument: "Función en el documento"
    },
    // Empty-state copy
    noFunctionsRecorded: "Sin cargos registrados",
    // Authority-link labels (: DBE + VIAF only; Wikidata omitted per )
    authorityLinks: {
      dbe: "Ver en Diccionario Biográfico Español (DBE)",
      viaf: "Ver en VIAF"
    },
    // Page copy
    breadcrumbParent: "Entidades",
    timelineHeader: "Apariciones en el archivo",
    linkedDescriptions: "Descripciones vinculadas",
    linkedDescriptionsLink: "Ver las {count} descripciones vinculadas",
    noLinkedDescriptions: "No se encontraron descripciones vinculadas a este registro.",
    shardError: "No se pudieron cargar las descripciones vinculadas. Intente recargar la página.",
    noDateLabel: "Sin fecha"
  },

  // Place authority records
  place: {
    // Type labels (plain Spanish geographic terms — )
    types: {
      city: "Lugar poblado",
      administrative_division: "División administrativa",
      region: "Región",
      country: "País",
      geographical_feature: "Accidente geográfico",
      river: "Cuerpo de agua",
      other: "Accidente geográfico"
    },
    // Section headers
    sections: {
      identification: "Identificación",
      externalIds: "Identificadores externos",
      control: "Control",
      reuse: "Reutilización"
    },
    // Field labels
    fields: {
      name: "Nombre",
      type: "Tipo",
      placeCode: "Identificador Neogranadina",
      nameVariants: "Variantes del nombre",
      coordinates: "Coordenadas",
      countryCode: "País"
    },
    // Page copy
    breadcrumbParent: "Lugares",
    timelineHeader: "Apariciones en el archivo",
    map: "Mapa",
    linkedDescriptions: "Descripciones vinculadas",
    linkedDescriptionsLink: "Ver las {count} descripciones vinculadas",
    noLinkedDescriptions: "No se encontraron descripciones vinculadas a este registro.",
    shardError: "No se pudieron cargar las descripciones vinculadas. Intente recargar la página.",
    noDateLabel: "Sin fecha",
    noCoordinatesTitle: "Ubicación no disponible",
    noCoordinatesText: "Este lugar no cuenta con coordenadas geográficas en el registro de autoridad."
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
