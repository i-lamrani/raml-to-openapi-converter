# RAML to OpenAPI Converter

This module converts RAML specifications to OpenAPI 3.0 format, preserving the original structure as much as possible while fixing compatibility issues.

## Features

- Full RAML 1.0 to OpenAPI 3.0 conversion
- Support for both local and remote files (URLs)
- Automatic resolution of RAML inclusions (`!include`)
- Endpoint filtering by path
- Intelligent schema transformation to ensure OpenAPI compatibility
- YAML or JSON output

## Installation

```bash
npm install raml-to-openapi-converter
```

## Usage

### Command Line

```bash
node convert.js path/to/api.raml path/to/output.yaml [options]
```

### Options

- `--json`: Output in JSON format instead of YAML
- `--debug`: Debug mode (preserves temporary files)
- `--endpoints=endpoint1,endpoint2,...`: Filter specified endpoints
- `--no-cleanup`: Disable automatic schema transformation

### Examples

```bash
# Simple conversion
node convert.js api.raml openapi.yaml

# Conversion with endpoint filtering
node convert.js api.raml openapi.yaml --endpoints=/users,/products

# Conversion from URL
node convert.js https://example.com/api.raml openapi.json --json

# Conversion without schema transformation
node convert.js api.raml openapi.yaml --no-cleanup
```

### As a Module

```javascript
const converter = require('raml-to-openapi-converter');

async function convertMyRaml() {
  const config = {
    ramlFilePath: 'api.raml',
    outputFilePath: 'openapi.yaml',
    outputAsJson: false,
    debugMode: false,
    endpointsFilter: ['/users', '/products'],
    noCleanup: false
  };

  try {
    const result = await converter.convertRamlToOpenApiFile(config);
    if (result.success) {
      console.log('Conversion successful!');
    } else {
      console.error('Conversion failed:', result.error);
    }
  } catch (error) {
    console.error('Error:', error);
  }
}

convertMyRaml();
```

## Schema Processing

The converter includes transformation logic to resolve common compatibility issues between RAML and OpenAPI schemas:

- Preservation of legitimate `id` properties in data models
- Conversion of non-standard types to valid OpenAPI types
- Transformation of JSON Schema `patternProperties` to OpenAPI equivalents
- Intelligent handling of format-specific properties

### Selective Transformation

Unlike standard converters, this implementation distinguishes between schema meta-properties (such as `$schema` or root-level `id`) and legitimate data model properties. This approach preserves the original structure while ensuring OpenAPI document validity.

For example:
- Root-level `$schema` and `id` properties are transformed to `x-json-schema` and `x-id` extensions
- `id` properties within data models are preserved
- `type` properties with non-standard values are transformed only at the schema level

## Dependencies

- raml-1-parser: for RAML file parsing
- js-yaml: for YAML/JSON conversion
- fs-extra: for advanced file operations
- axios: for downloading remote resources

## License

MIT