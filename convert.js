#!/usr/bin/env node

/**
 * Transform the OpenAPI schema to fix validation issues while preserving data structure
 * @param {Object} openApiDoc OpenAPI document
 * @returns {Object} Transformed OpenAPI document
 */
function transformOpenApiSchema(openApiDoc) {
    if (!openApiDoc || typeof openApiDoc !== 'object') {
      return openApiDoc;
    }
  
    // Create a deep copy to avoid modifying the original
    const transformedDoc = JSON.parse(JSON.stringify(openApiDoc));
    
    // Transform schemas
    if (transformedDoc.components && transformedDoc.components.schemas) {
      Object.keys(transformedDoc.components.schemas).forEach(schemaName => {
        const schema = transformedDoc.components.schemas[schemaName];
        transformSchema(schema, true); // true indicates root level schema
      });
    }
    
    return transformedDoc;
  }
  
  /**
   * Recursively transform a schema object while preserving data model properties
   * @param {Object} schema Schema object to transform
   * @param {boolean} isRootSchema Whether this is a root level schema definition
   * @param {string} parentKey The parent property key context
   */
  function transformSchema(schema, isRootSchema = false, parentKey = '') {
    if (!schema || typeof schema !== 'object') {
      return;
    }
  
    // Handle arrays
    if (Array.isArray(schema)) {
      schema.forEach(item => transformSchema(item, false, parentKey));
      return;
    }
    
    // Transform special properties only at the schema root level, not in data models
    if (isRootSchema) {
      // Transform JSON Schema-specific properties to OpenAPI extensions at schema root level only
      if (schema.$schema) {
        schema['x-json-schema'] = schema.$schema;
        delete schema.$schema;
      }
      
      // Move id to x-id only at schema root level
      if (schema.id && typeof schema.id === 'string' && parentKey !== 'properties') {
        schema['x-id'] = schema.id;
        delete schema.id;
      }
    }
    
    // Process object properties
    Object.keys(schema).forEach(key => {
      const value = schema[key];
      
      // Transform nested objects
      if (value && typeof value === 'object') {
        // Pass contextual information to nested calls
        const isPropertyDefinition = key === 'properties';
        const isNestedRootSchema = key === 'schema' || key === 'items';
        
        transformSchema(
          value, 
          isNestedRootSchema, 
          isPropertyDefinition ? 'properties' : key
        );
      }
      
      // Fix type issues in type fields only for schema type declarations, not for data properties
      if (key === 'type' && typeof value === 'string' && isRootSchema) {
        const validTypes = ['array', 'boolean', 'integer', 'number', 'object', 'string', 'null'];
        if (!validTypes.includes(value)) {
          // Add x-original-type to preserve the original value
          schema['x-original-type'] = value;
          // Default to 'object' for invalid types
          schema[key] = 'object';
        }
      }
      
      // Transform database property to x-database extension
      if (key === 'database' && (isRootSchema || parentKey === 'properties')) {
        schema['x-database'] = value;
        delete schema[key];
      }
      
      // Transform patternProperties (not supported in OpenAPI 3.0)
      if (key === 'patternProperties') {
        // Store original patternProperties as x-pattern-properties
        schema['x-pattern-properties'] = value;
        
        // Create a compatible additionalProperties equivalent
        if (!schema.additionalProperties) {
          // Find a common type among pattern property schemas
          let commonType = 'object';
          const patterns = Object.values(value);
          if (patterns.length > 0) {
            const firstPattern = patterns[0];
            if (firstPattern && firstPattern.type) {
              commonType = firstPattern.type;
            }
          }
          
          schema.additionalProperties = { type: commonType };
        }
        
        delete schema[key];
      }
    });
  }
  const fs = require('fs-extra');
  const path = require('path');
  const yaml = require('js-yaml');
  const axios = require('axios');
  const { URL } = require('url');
  const ramlParser = require('raml-1-parser');
  const os = require('os');
  
  /**
   * Display help message
   */
  function displayHelp() {
    console.log(`
RAML to OpenAPI Converter
=========================

Usage:
  raml-to-openapi <raml-file> <output-file> [options]

Arguments:
  raml-file             Path to the input RAML file (local or URL)
  output-file           Path to the output OpenAPI file (default: openapi.yaml)

Options:
  --json                Output in JSON format instead of YAML
  --debug               Debug mode (preserves temporary files)
  --endpoints=<list>    Filter specified endpoints (comma-separated list)
  --no-cleanup          Disable automatic schema transformation
  --help                Display this help message

Examples:
  raml-to-openapi api.raml openapi.yaml
  raml-to-openapi api.raml openapi.json --json
  raml-to-openapi https://example.com/api.raml openapi.yaml
  raml-to-openapi api.raml openapi.yaml --endpoints=/users,/products
  raml-to-openapi api.raml openapi.yaml --no-cleanup
    `);
    process.exit(0);
  }

  /**
   * Create configuration from command line arguments
   * @param {string[]} args Command line arguments
   * @returns {Object} Configuration
   */
  function createConfig(args = process.argv.slice(2)) {
    // Show help if requested
    if (args.includes('--help') || args.includes('-h')) {
      displayHelp();
    }

    // Handle version flag
    if (args.includes('--version') || args.includes('-v')) {
      const packageJson = require('./package.json');
      console.log(`raml-to-openapi-converter v${packageJson.version}`);
      process.exit(0);
    }

    // If no arguments provided, show help
    if (args.length === 0) {
      displayHelp();
    }

    return {
      ramlFilePath: args[0] || 'api.raml',
      outputFilePath: args[1] || 'openapi.yaml',
      outputAsJson: args.includes('--json'),
      debugMode: args.includes('--debug'),
      endpointsFilter: args.find((arg, index) => arg === '--endpoints' && args[index + 1]) 
        ? args[args.findIndex(arg => arg === '--endpoints') + 1].split(',') 
        : null,
      noCleanup: args.includes('--no-cleanup')
    };
  }
  
  /**
   * File utilities
   */
  const fileUtils = {
    /**
     * Check if a string is a URL
     * @param {string} str String to check
     * @returns {boolean} True if it's a URL
     */
    isUrl(str) {
      return /^https?:\/\//.test(str);
    },
  
    /**
     * Read a file from a local path or URL
     * @param {string} filePathOrUrl File path or URL
     * @returns {Promise<string>} File content
     */
    async readFile(filePathOrUrl) {
      try {
        return this.isUrl(filePathOrUrl)
          ? (await axios.get(filePathOrUrl)).data
          : fs.readFileSync(path.resolve(filePathOrUrl), 'utf8');
      } catch (err) {
        throw new Error(`Error reading ${filePathOrUrl}: ${err.message}`);
      }
    },
  
    /**
     * Write a file
     * @param {string} filePath File path
     * @param {string} content Content to write
     */
    writeFile(filePath, content) {
      try {
        // Check if the destination path is a URL
        if (this.isUrl(filePath)) {
          throw new Error(`Cannot write to a URL: ${filePath}`);
        }
        
        // Create parent directories if needed
        const dirPath = path.dirname(filePath);
        if (!fs.existsSync(dirPath)) {
          fs.mkdirSync(dirPath, { recursive: true });
        }
        
        fs.writeFileSync(filePath, content);
      } catch (err) {
        throw new Error(`Error writing to ${filePath}: ${err.message}`);
      }
    },
  
    /**
     * Get file extension
     * @param {string} filePath File path
     * @returns {string} File extension
     */
    getExtension(filePath) {
      return path.extname(filePath).toLowerCase();
    },
  
    /**
     * Get base name of a file without extension
     * @param {string} filePath File path
     * @returns {string} Base name
     */
    getBaseName(filePath) {
      return path.basename(filePath, this.getExtension(filePath));
    }
  };
  
  /**
   * Download a file from a URL and save it locally
   * @param {string} url URL of the file
   * @param {string} destPath Destination path
   * @returns {Promise<void>}
   */
  async function downloadAndSave(url, destPath) {
    try {
      const res = await axios.get(url, { responseType: 'text' });
      await fs.outputFile(destPath, res.data);
      console.log(`📥 Downloaded: ${url} -> ${destPath}`);
    } catch (err) {
      console.warn(`⚠️ Download failed: ${url}: ${err.message}`);
    }
  }
  
  /**
   * Download all included files (!include) in a RAML
   * @param {string} baseUrl Base URL
   * @param {string} ramlContent RAML content
   * @param {string} basePath Base path to save files
   * @returns {Promise<string>} Modified RAML content
   */
  async function downloadIncludes(baseUrl, ramlContent, basePath) {
    const includeRegex = /!include\s+(.+)/g;
    const matches = [...ramlContent.matchAll(includeRegex)];
    let modifiedContent = ramlContent;
  
    console.log(`🔍 Downloading ${matches.length} included files...`);
    
    for (const match of matches) {
      let includePath = match[1].trim().replace(/['"]/g, '');
      
      try {
        if (fileUtils.isUrl(includePath)) {
          // Inclusion is already a complete URL
          const dest = path.join(basePath, path.basename(includePath));
          await downloadAndSave(includePath, dest);
          modifiedContent = modifiedContent.replace(match[0], `!include ${path.basename(includePath)}`);
        } else if (!fs.existsSync(path.join(basePath, includePath))) {
          // Inclusion is a relative path that doesn't exist yet
          try {
            // Create parent directory if needed
            const fullPath = path.join(basePath, includePath);
            const dir = path.dirname(fullPath);
            if (!fs.existsSync(dir)) {
              fs.mkdirSync(dir, { recursive: true });
            }
            
            // Download the file
            const fullUrl = new URL(includePath, baseUrl).href;
            await downloadAndSave(fullUrl, fullPath);
          } catch (err) {
            console.warn(`⚠️ Inclusion issue: ${includePath}: ${err.message}`);
          }
        }
      } catch (err) {
        console.warn(`⚠️ Processing error for ${includePath}: ${err.message}`);
      }
    }
  
    return modifiedContent;
  }
  
  /**
   * Filter endpoints in the expanded RAML document
   * @param {Object} ramlDoc Expanded RAML document
   * @param {string[]} endpointsFilter List of endpoints to keep
   * @returns {Object} Filtered RAML document
   */
  function filterEndpoints(ramlDoc, endpointsFilter) {
    if (!endpointsFilter || !Array.isArray(endpointsFilter) || endpointsFilter.length === 0) {
      return ramlDoc;
    }
  
    // Normalize endpoint filters to ensure they start with "/"
    const normalizedFilters = endpointsFilter.map(filter => 
      filter.startsWith("/") ? filter : `/${filter}`
    );
  
    // Create a copy of the RAML document
    const filteredDoc = { ...ramlDoc };
    
    // If document has resources, filter them
    if (filteredDoc.resources && Array.isArray(filteredDoc.resources)) {
      const originalResources = [...filteredDoc.resources];
      filteredDoc.resources = [];
      
      // Go through all resources and keep only those matching the specified endpoints
      for (const resource of originalResources) {
        const resourceUri = resource.relativeUri || '';
        
        // Check if the resource URI matches one of the filters
        const matchesFilter = normalizedFilters.some(filter => {
          // Handle special cases like regex patterns or wildcards
          if (filter.includes("*")) {
            const regexPattern = "^" + filter.replace(/\*/g, ".*") + "$";
            const regex = new RegExp(regexPattern);
            return regex.test(resourceUri);
          }
          return resourceUri === filter || resourceUri.startsWith(filter + "/") || filter.startsWith(resourceUri + "/");
        });
        
        if (matchesFilter) {
          filteredDoc.resources.push(resource);
        } else if (resource.resources && Array.isArray(resource.resources)) {
          // For nested resources, apply filter recursively
          const filteredSubResources = filterNestedResources(resource, normalizedFilters);
          if (filteredSubResources.resources && filteredSubResources.resources.length > 0) {
            filteredDoc.resources.push(filteredSubResources);
          }
        }
      }
    }
    
    return filteredDoc;
  }
  
  /**
   * Filter nested resources
   * @param {Object} resource Parent resource
   * @param {string[]} endpointsFilter List of endpoints to keep
   * @returns {Object} Resource with filtered nested resources
   */
  function filterNestedResources(resource, endpointsFilter) {
    if (!resource.resources || !Array.isArray(resource.resources)) {
      return resource;
    }
    
    const filteredResource = { ...resource };
    const parentUri = resource.relativeUri || '';
    
    // Filter nested resources
    filteredResource.resources = resource.resources.filter(subResource => {
      const fullUri = parentUri + (subResource.relativeUri || '');
      
      return endpointsFilter.some(filter => {
        if (filter.includes("*")) {
          const regexPattern = "^" + filter.replace(/\*/g, ".*") + "$";
          const regex = new RegExp(regexPattern);
          return regex.test(fullUri);
        }
        return fullUri === filter || fullUri.startsWith(filter + "/") || filter.startsWith(fullUri + "/");
      });
    });
    
    // Apply recursively to remaining nested resources
    filteredResource.resources = filteredResource.resources.map(subResource => 
      filterNestedResources(subResource, endpointsFilter)
    );
    
    return filteredResource;
  }
  
  /**
   * Traite les chaînes JSON dans le document RAML étendu
   * @param {Object} expandedJson Document RAML étendu
   * @returns {Object} Document avec les chaînes JSON parsées
   */
  function processJsonStrings(expandedJson) {
    if (expandedJson === null || typeof expandedJson !== 'object') {
      return expandedJson;
    }
  
    if (Array.isArray(expandedJson)) {
      return expandedJson.map(item => processJsonStrings(item));
    }
  
    const result = {};
    for (const [key, value] of Object.entries(expandedJson)) {
      if (typeof value === 'string' && value.startsWith('{') && value.endsWith('}')) {
        try {
          // Tenter de parser la chaîne JSON
          result[key] = JSON.parse(value);
        } catch (e) {
          // Si échec, conserver la chaîne originale
          result[key] = value;
        }
      } else if (value === null || typeof value !== 'object') {
        // Valeurs primitives - conserver telles quelles
        result[key] = value;
      } else {
        // Objets et tableaux - traiter récursivement
        result[key] = processJsonStrings(value);
      }
    }
  
    return result;
  }
  
  /**
   * Convertit un document RAML en OpenAPI
   * @param {Object} ramlDoc Document RAML étendu
   * @returns {Object} Document OpenAPI
   */
  function convertRamlToOpenApi(ramlDoc) {
    // Traiter les chaînes JSON d'abord
    const processedRamlDoc = processJsonStrings(ramlDoc);
    
    // Extraire les métadonnées de base
    const title = processedRamlDoc.title || 'API';
    const version = processedRamlDoc.version || '1.0.0';
    let baseUri = processedRamlDoc.baseUri || 'https://api.example.com/api/{version}';
    baseUri = baseUri.replace('{version}', version);
    
    // Créer le document OpenAPI de base
    const openApiDoc = {
      openapi: '3.0.0',
      info: {
        title,
        version,
        description: processedRamlDoc.documentation && processedRamlDoc.documentation.length > 0
          ? processedRamlDoc.documentation[0].content
          : `API convertie depuis RAML vers OpenAPI 3.0`
      },
      servers: [{
        url: baseUri
      }],
      paths: {},
      components: {
        schemas: {},
        securitySchemes: {}
      }
    };
    
    // Collecter tous les schémas disponibles d'abord
    const allSchemas = {};
    
    // Extraire les schémas
    if (processedRamlDoc.schemas && Array.isArray(processedRamlDoc.schemas)) {
      processedRamlDoc.schemas.forEach(schemaObj => {
        if (typeof schemaObj === 'object' && schemaObj !== null) {
          Object.entries(schemaObj).forEach(([name, schema]) => {
            allSchemas[name] = schema;
          });
        }
      });
    } else if (processedRamlDoc.schemas && typeof processedRamlDoc.schemas === 'object') {
      Object.entries(processedRamlDoc.schemas).forEach(([name, schema]) => {
        allSchemas[name] = schema;
      });
    }
    
    // Traiter les types RAML 1.0
    if (processedRamlDoc.types && typeof processedRamlDoc.types === 'object') {
      Object.entries(processedRamlDoc.types).forEach(([name, type]) => {
        allSchemas[name] = type;
      });
    }
    
    // Collecter les schémas référencés
    const referencedSchemas = new Set();
    
    // Extraire les chemins et méthodes
    if (processedRamlDoc.resources && Array.isArray(processedRamlDoc.resources)) {
      processedRamlDoc.resources.forEach(resource => {
        const pathUrl = resource.relativeUri;
        if (!openApiDoc.paths[pathUrl]) {
          openApiDoc.paths[pathUrl] = {};
        }
        
        // Traiter les méthodes de chaque ressource
        if (resource.methods && Array.isArray(resource.methods)) {
          resource.methods.forEach(method => {
            const httpMethod = method.method.toLowerCase();
            openApiDoc.paths[pathUrl][httpMethod] = convertMethod(method, resource, referencedSchemas);
          });
        }
        
        // Traiter les ressources imbriquées
        if (resource.resources && Array.isArray(resource.resources)) {
          processNestedResources(resource.resources, pathUrl, openApiDoc.paths, referencedSchemas);
        }
      });
    }
    
    // Ajouter uniquement les schémas référencés
    for (const schemaName of referencedSchemas) {
      if (allSchemas[schemaName]) {
        openApiDoc.components.schemas[schemaName] = allSchemas[schemaName];
        
        // Ajouter également les schémas référencés par ce schéma
        addReferencedSchemas(schemaName, allSchemas, openApiDoc.components.schemas, referencedSchemas);
      }
    }
    
    // Traiter la sécurité
    if (processedRamlDoc.securitySchemes && Array.isArray(processedRamlDoc.securitySchemes)) {
      processedRamlDoc.securitySchemes.forEach(schemeObj => {
        if (typeof schemeObj === 'object' && schemeObj !== null) {
          Object.entries(schemeObj).forEach(([name, scheme]) => {
            openApiDoc.components.securitySchemes[name] = convertSecurityScheme(scheme);
          });
        }
      });
      
      // Si des schémas de sécurité ont été trouvés, définir la sécurité par défaut
      if (Object.keys(openApiDoc.components.securitySchemes).length > 0) {
        openApiDoc.security = [
          { [Object.keys(openApiDoc.components.securitySchemes)[0]]: [] }
        ];
      }
    }
    
    return openApiDoc;
  }
  
  /**
   * Ajoute récursivement les schémas référencés par un schéma
   * @param {string} schemaName Nom du schéma
   * @param {Object} allSchemas Tous les schémas disponibles
   * @param {Object} targetSchemas Schémas cibles où ajouter
   * @param {Set} referencedSchemas Set des schémas déjà référencés
   */
  function addReferencedSchemas(schemaName, allSchemas, targetSchemas, referencedSchemas) {
    const schema = allSchemas[schemaName];
    if (!schema) return;
    
    // Parcourir le schéma pour trouver des références
    findSchemaReferences(schema, allSchemas, targetSchemas, referencedSchemas);
  }
  
  /**
   * Recherche récursivement les références de schémas
   * @param {Object} obj Objet à analyser
   * @param {Object} allSchemas Tous les schémas disponibles
   * @param {Object} targetSchemas Schémas cibles où ajouter
   * @param {Set} referencedSchemas Set des schémas déjà référencés
   */
  function findSchemaReferences(obj, allSchemas, targetSchemas, referencedSchemas) {
    if (!obj || typeof obj !== 'object') return;
    
    if (Array.isArray(obj)) {
      obj.forEach(item => findSchemaReferences(item, allSchemas, targetSchemas, referencedSchemas));
      return;
    }
    
    for (const [key, value] of Object.entries(obj)) {
      // Chercher les références explicites
      if (key === '$ref' && typeof value === 'string') {
        const match = value.match(/#\/components\/schemas\/(.+)$/);
        if (match && match[1]) {
          const refSchemaName = match[1];
          if (allSchemas[refSchemaName] && !targetSchemas[refSchemaName]) {
            referencedSchemas.add(refSchemaName);
            targetSchemas[refSchemaName] = allSchemas[refSchemaName];
            // Rechercher récursivement
            findSchemaReferences(allSchemas[refSchemaName], allSchemas, targetSchemas, referencedSchemas);
          }
        }
      }
      // Chercher les références implicites (type)
      else if (key === 'type' && typeof value === 'string' && 
               !['string', 'number', 'integer', 'boolean', 'array', 'object', 'null'].includes(value.toLowerCase()) &&
               allSchemas[value]) {
        if (!targetSchemas[value]) {
          referencedSchemas.add(value);
          targetSchemas[value] = allSchemas[value];
          // Rechercher récursivement
          findSchemaReferences(allSchemas[value], allSchemas, targetSchemas, referencedSchemas);
        }
      }
      // Continuer récursivement dans les objets imbriqués
      else if (value && typeof value === 'object') {
        findSchemaReferences(value, allSchemas, targetSchemas, referencedSchemas);
      }
    }
  }
  
  /**
   * Traite les ressources imbriquées dans le RAML
   * @param {Array} resources Ressources imbriquées
   * @param {string} parentPath Chemin parent
   * @param {Object} paths Objet paths d'OpenAPI
   * @param {Set} referencedSchemas Set des schémas référencés
   */
  function processNestedResources(resources, parentPath, paths, referencedSchemas) {
    resources.forEach(resource => {
      const fullPath = `${parentPath}${resource.relativeUri}`;
      if (!paths[fullPath]) {
        paths[fullPath] = {};
      }
      
      // Traiter les méthodes
      if (resource.methods && Array.isArray(resource.methods)) {
        resource.methods.forEach(method => {
          const httpMethod = method.method.toLowerCase();
          paths[fullPath][httpMethod] = convertMethod(method, resource, referencedSchemas);
        });
      }
      
      // Traiter récursivement les ressources imbriquées
      if (resource.resources && Array.isArray(resource.resources)) {
        processNestedResources(resource.resources, fullPath, paths, referencedSchemas);
      }
    });
  }
  
  /**
   * Convertit une méthode RAML en opération OpenAPI
   * @param {Object} method Méthode RAML
   * @param {Object} resource Ressource parente
   * @param {Set} referencedSchemas Set des schémas référencés
   * @returns {Object} Opération OpenAPI
   */
  function convertMethod(method, resource, referencedSchemas = new Set()) {
    const operation = {
      description: method.description || '',
      parameters: [],
      responses: {}
    };
    
    // Ajouter les paramètres de chemin (URI)
    extractUriParameters(resource, operation.parameters);
    
    // Ajouter les paramètres de requête
    if (method.queryParameters) {
      Object.entries(method.queryParameters).forEach(([name, param]) => {
        operation.parameters.push(convertParameter(name, param, 'query'));
      });
    }
    
    // Traiter le corps de la requête
    if (method.body) {
      operation.requestBody = convertRequestBody(method.body, referencedSchemas);
    }
    
    // Traiter les réponses
    if (method.responses) {
      Object.entries(method.responses).forEach(([code, response]) => {
        operation.responses[code] = convertResponse(response, referencedSchemas);
      });
    }
    
    // Si aucune réponse n'est définie, ajouter une réponse 200 par défaut
    if (Object.keys(operation.responses).length === 0) {
      operation.responses['200'] = {
        description: 'Réponse réussie',
        content: {
          'application/json': {
            schema: { type: 'object' }
          }
        }
      };
    }
    
    return operation;
  }
  
  /**
   * Extrait les paramètres d'URI
   * @param {Object} resource Ressource RAML
   * @param {Array} parameters Tableau des paramètres OpenAPI
   */
  function extractUriParameters(resource, parameters) {
    // Extraire les paramètres de l'URI à partir du chemin
    const pathParamRegex = /{([^}]+)}/g;
    const relativeUri = resource.relativeUri || '';
    let match;
    
    while ((match = pathParamRegex.exec(relativeUri)) !== null) {
      const paramName = match[1];
      
      // Vérifier si le paramètre existe déjà dans le tableau
      if (!parameters.some(p => p.name === paramName && p.in === 'path')) {
        // Vérifier si le paramètre est défini dans uriParameters
        let paramDef = resource.uriParameters 
          ? resource.uriParameters[paramName] 
          : null;
        
        if (paramDef) {
          parameters.push(convertParameter(paramName, paramDef, 'path'));
        } else {
          // Paramètre par défaut si non défini
          parameters.push({
            name: paramName,
            in: 'path',
            required: true,
            description: `Paramètre de chemin ${paramName}`,
            schema: { type: 'string' }
          });
        }
      }
    }
    
    // Ajouter les paramètres d'URI explicitement définis mais pas dans le chemin
    if (resource.uriParameters) {
      Object.entries(resource.uriParameters).forEach(([name, param]) => {
        if (!parameters.some(p => p.name === name && p.in === 'path')) {
          parameters.push(convertParameter(name, param, 'path'));
        }
      });
    }
  }
  
  /**
   * Convertit un paramètre RAML en paramètre OpenAPI
   * @param {string} name Nom du paramètre
   * @param {Object} param Définition du paramètre RAML
   * @param {string} paramType Type de paramètre ('query', 'path', etc.)
   * @returns {Object} Paramètre OpenAPI
   */
  function convertParameter(name, param, paramType) {
    const parameter = {
      name,
      in: paramType,
      required: paramType === 'path' || param.required === true,
      description: param.description || `Paramètre ${name}`
    };
    
    // Convertir le type
    parameter.schema = {
      type: mapRamlTypeToOpenApi(param.type || 'string')
    };
    
    // Ajouter le format si disponible
    const format = getFormatForType(param.type);
    if (format) {
      parameter.schema.format = format;
    }
    
    // Ajouter enum si disponible
    if (param.enum) {
      parameter.schema.enum = param.enum;
    }
    
    // Ajouter min/max si disponible
    if (param.minimum !== undefined) {
      parameter.schema.minimum = parseFloat(param.minimum);
    }
    if (param.maximum !== undefined) {
      parameter.schema.maximum = parseFloat(param.maximum);
    }
    
    // Ajouter pattern si disponible
    if (param.pattern) {
      parameter.schema.pattern = param.pattern;
    }
    
    // Ajouter default si disponible
    if (param.default !== undefined) {
      parameter.schema.default = param.default;
    }
    
    return parameter;
  }
  
  /**
   * Convertit le corps de la requête RAML en requestBody OpenAPI
   * @param {Object} body Corps de la requête RAML
   * @param {Set} referencedSchemas Set des schémas référencés
   * @returns {Object} requestBody OpenAPI
   */
  function convertRequestBody(body, referencedSchemas = new Set()) {
    const requestBody = {
      required: true,
      content: {}
    };
    
    // Parcourir tous les types de contenu
    Object.entries(body).forEach(([contentType, bodyDef]) => {
      let schema = { type: 'object' };  // Schéma par défaut
      
      // Si body définit un schema
      if (bodyDef.schema) {
        schema = { $ref: `#/components/schemas/${bodyDef.schema}` };
        // Collecter le schéma référencé
        referencedSchemas.add(bodyDef.schema);
      } 
      // Si body définit un type
      else if (bodyDef.type) {
        if (bodyDef.type.toLowerCase() === 'file') {
          schema = {
            type: 'string',
            format: 'binary'
          };
        } else if (!['string', 'number', 'integer', 'boolean', 'array', 'object', 'null'].includes(bodyDef.type.toLowerCase())) {
          schema = { $ref: `#/components/schemas/${bodyDef.type}` };
          // Collecter le schéma référencé
          referencedSchemas.add(bodyDef.type);
        } else {
          schema = { type: mapRamlTypeToOpenApi(bodyDef.type) };
        }
      }
      
      requestBody.content[contentType] = { schema };
      
      // Marquer comme non requis si spécifié
      if (bodyDef.required === false) {
        requestBody.required = false;
      }
    });
    
    return requestBody;
  }
  
  /**
   * Convertit une réponse RAML en réponse OpenAPI
   * @param {Object} response Réponse RAML
   * @param {Set} referencedSchemas Set des schémas référencés
   * @returns {Object} Réponse OpenAPI
   */
  function convertResponse(response, referencedSchemas = new Set()) {
    const openApiResponse = {
      description: response.description || 'Réponse',
      content: {}
    };
    
    // Si la réponse a un corps
    if (response.body) {
      Object.entries(response.body).forEach(([contentType, bodyDef]) => {
        let schema = { type: 'object' };  // Schéma par défaut
        
        // Si le corps définit un schema
        if (bodyDef.schema) {
          schema = { $ref: `#/components/schemas/${bodyDef.schema}` };
          // Collecter le schéma référencé
          referencedSchemas.add(bodyDef.schema);
        } 
        // Si le corps définit un type
        else if (bodyDef.type) {
          if (!['string', 'number', 'integer', 'boolean', 'array', 'object', 'null'].includes(bodyDef.type.toLowerCase())) {
            schema = { $ref: `#/components/schemas/${bodyDef.type}` };
            // Collecter le schéma référencé
            referencedSchemas.add(bodyDef.type);
          } else {
            schema = { type: mapRamlTypeToOpenApi(bodyDef.type) };
          }
        }
        
        openApiResponse.content[contentType] = { schema };
      });
    } else {
      // Réponse par défaut si aucun corps n'est défini
      openApiResponse.content['application/json'] = {
        schema: { type: 'object' }
      };
    }
    
    return openApiResponse;
  }
  
  /**
   * Convertit un schéma de sécurité RAML en schéma OpenAPI
   * @param {Object} scheme Schéma de sécurité RAML
   * @returns {Object} Schéma de sécurité OpenAPI
   */
  function convertSecurityScheme(scheme) {
    if (!scheme || typeof scheme !== 'object') {
      return null;
    }
    
    switch (scheme.type) {
      case 'Basic Authentication':
      case 'basic':
        return {
          type: 'http',
          scheme: 'basic',
          description: scheme.description || 'Basic Authentication'
        };
        
      case 'OAuth 2.0':
      case 'OAuth':
      case 'oauth2':
      case 'oauth':
        return convertOAuth2Scheme(scheme);
        
      case 'apiKey':
        return {
          type: 'apiKey',
          name: scheme.name || 'apiKey',
          in: scheme.in || 'header',
          description: scheme.description || 'API Key Authentication'
        };
        
      default:
        return {
          type: 'apiKey',
          name: scheme.name || 'apiKey',
          in: scheme.in || 'header',
          description: scheme.description || 'API Authentication'
        };
    }
  }
  
  /**
   * Convertit un schéma OAuth2 RAML en schéma OpenAPI
   * @param {Object} scheme Schéma OAuth2 RAML
   * @returns {Object} Schéma OAuth2 OpenAPI
   */
  function convertOAuth2Scheme(scheme) {
    const oauth2Scheme = {
      type: 'oauth2',
      flows: {},
      description: scheme.description || 'OAuth 2.0 Authentication'
    };
    
    const settings = scheme.settings || {};
    
    // Configuration du flux implicite
    if (settings.authorizationUri) {
      oauth2Scheme.flows.implicit = {
        authorizationUrl: settings.authorizationUri,
        scopes: settings.scopes || {}
      };
      
      // Configuration du flux d'autorisation par code
      if (settings.accessTokenUri) {
        oauth2Scheme.flows.authorizationCode = {
          authorizationUrl: settings.authorizationUri,
          tokenUrl: settings.accessTokenUri,
          scopes: settings.scopes || {}
        };
      }
    }
    
    // Configuration du flux d'informations d'identification client
    if (settings.accessTokenUri && !settings.authorizationUri) {
      oauth2Scheme.flows.clientCredentials = {
        tokenUrl: settings.accessTokenUri,
        scopes: settings.scopes || {}
      };
    }
    
    return oauth2Scheme;
  }
  
  /**
   * Mappe un type RAML à un type OpenAPI
   * @param {string} ramlType Type RAML
   * @returns {string} Type OpenAPI
   */
  function mapRamlTypeToOpenApi(ramlType) {
    if (!ramlType) return 'string';
    
    const typeMap = {
      'number': 'number',
      'integer': 'integer',
      'string': 'string',
      'boolean': 'boolean',
      'file': 'string',
      'date-only': 'string',
      'time-only': 'string',
      'datetime-only': 'string',
      'datetime': 'string',
      'object': 'object',
      'array': 'array',
      'nil': 'null',
      'any': 'object'
    };
    
    return typeMap[ramlType.toLowerCase()] || 'string';
  }
  
  /**
   * Obtient le format pour un type RAML
   * @param {string} type Type RAML
   * @returns {string|undefined} Format OpenAPI
   */
  function getFormatForType(type) {
    if (!type) return undefined;
    
    const formatMap = {
      'date-only': 'date',
      'time-only': 'time',
      'datetime-only': 'date-time',
      'datetime': 'date-time',
      'file': 'binary',
      'uuid': 'uuid',
      'uri': 'uri',
      'email': 'email'
    };
    
    return formatMap[type.toLowerCase()];
  }
  
  /**
   * Main function to convert a RAML file to OpenAPI
   * @param {Object} config Configuration
   * @returns {Promise<Object>} Conversion result
   */
  async function convertRamlToOpenApiFile(config) {
    try {
      console.log(`🚀 Starting conversion of ${config.ramlFilePath} to OpenAPI`);
      
      // Display endpoint filters if specified
      if (config.endpointsFilter && config.endpointsFilter.length > 0) {
        console.log(`🔍 Filtering endpoints: ${config.endpointsFilter.join(', ')}`);
      }
      
      // Prepare a temporary directory for included files
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'raml-'));
      let mainRamlPath = path.join(tmpDir, 'api.raml');
      
      // Read and prepare the RAML file
      let ramlContent;
      
      if (fileUtils.isUrl(config.ramlFilePath)) {
        console.log(`📥 Downloading RAML file from ${config.ramlFilePath}`);
        ramlContent = await fileUtils.readFile(config.ramlFilePath);
        const baseUrl = new URL('.', config.ramlFilePath).href;
        
        // Download all included files
        console.log(`🔍 Processing included files...`);
        ramlContent = await downloadIncludes(baseUrl, ramlContent, tmpDir);
        
        // Save the main RAML
        await fs.writeFile(mainRamlPath, ramlContent);
      } else {
        // If it's a local file, we simply copy it to the temporary directory
        console.log(`📁 Using local RAML file: ${config.ramlFilePath}`);
        ramlContent = await fileUtils.readFile(config.ramlFilePath);
        
        // Copy the file to the temporary directory
        const sourceDir = path.dirname(path.resolve(config.ramlFilePath));
        await fs.copy(sourceDir, tmpDir, {
          filter: (src) => {
            // Exclude node_modules and .git directories
            return !src.includes('node_modules') && !src.includes('.git');
          }
        });
        
        // Write the main file
        const mainFileName = path.basename(config.ramlFilePath);
        await fs.writeFile(path.join(tmpDir, mainFileName), ramlContent);
        
        // Update the main file path
        mainRamlPath = path.join(tmpDir, mainFileName);
      }
      
      console.log(`🔄 Parsing RAML document with raml-1-parser...`);
      const api = ramlParser.loadApiSync(mainRamlPath);
      
      if (!api) {
        throw new Error(`Failed to parse RAML document`);
      }
      
      console.log(`📦 Expanding RAML document...`);
      let expandedRaml = api.expand(true).toJSON();
      
      // Filter endpoints if needed
      if (config.endpointsFilter && config.endpointsFilter.length > 0) {
        console.log(`✂️ Filtering endpoints according to specified criteria...`);
        expandedRaml = filterEndpoints(expandedRaml, config.endpointsFilter);
      }
      
      console.log(`🔧 Converting RAML document to OpenAPI...`);
      let openApiDoc = convertRamlToOpenApi(expandedRaml);
      
      // Transform schema unless --no-cleanup is specified
      if (!config.noCleanup) {
        console.log(`🔄 Transforming OpenAPI schema to ensure validation compatibility...`);
        openApiDoc = transformOpenApiSchema(openApiDoc);
      } else {
        console.log(`ℹ️ Schema transformation skipped (--no-cleanup specified)`);
      }
      
      console.log(`💾 Generating OpenAPI document...`);
      const serialized = config.outputAsJson 
        ? JSON.stringify(openApiDoc, null, 2)
        : yaml.dump(openApiDoc, {
            indent: 2,
            lineWidth: -1,
            noRefs: true,
            sortKeys: false
          });
      
      fileUtils.writeFile(config.outputFilePath, serialized);
      
      console.log(`\n✅ OpenAPI generated successfully in ${config.outputFilePath}`);
      
      // Clean up temporary files if needed
      if (!config.debugMode) {
        await fs.remove(tmpDir);
      } else {
        console.log(`🔍 Debug mode: temporary files are kept in ${tmpDir}`);
      }
      
      return { success: true, openApiDoc };
    } catch (error) {
      console.error(`❌ Error during conversion: ${error.message}`);
      if (config.debugMode) {
        console.error(error.stack);
      }
      return { success: false, error };
    }
  }
  
  /**
   * Entry point
   */
  async function main() {
    const config = createConfig();
    
    try {
      await convertRamlToOpenApiFile(config);
    } catch (error) {
      console.error(`❌ Fatal error: ${error.message}`);
      process.exit(1);
    }
  }
  
  // Direct execution
  if (require.main === module) {
    main().catch(console.error);
  }
  
  // Exports for use as a module
  module.exports = {
    convertRamlToOpenApiFile,
    convertRamlToOpenApi,
    filterEndpoints,
    transformOpenApiSchema,
    fileUtils
  };