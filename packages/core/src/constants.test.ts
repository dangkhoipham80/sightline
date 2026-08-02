import { describe, expect, it } from 'vitest'
import { PRODUCT_NAME, SIGHTLINE_SCHEMA_VERSION } from './index.js'

describe('@sightline/core', () => {
  it('exposes the product name', () => {
    expect(PRODUCT_NAME).toBe('Sightline')
  })

  it('pins a positive integer schema version', () => {
    expect(Number.isInteger(SIGHTLINE_SCHEMA_VERSION)).toBe(true)
    expect(SIGHTLINE_SCHEMA_VERSION).toBeGreaterThan(0)
  })
})
