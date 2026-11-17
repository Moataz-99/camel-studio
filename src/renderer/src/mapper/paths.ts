/** Where a mapping's files live, relative to the project root. */
export const MAPPINGS_DIR = 'src/main/camel-studio/mappings'
export const SCHEMAS_DIR = 'src/main/camel-studio/schemas'
export const XSL_DIR = 'src/main/resources/mappings'

export const mappingRel = (name: string): string => `${MAPPINGS_DIR}/${name}.mapping.json`
export const xslRel = (name: string): string => `${XSL_DIR}/${name}.xsl`
