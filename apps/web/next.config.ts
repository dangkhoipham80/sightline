import type { NextConfig } from 'next'

/**
 * better-sqlite3 is a native addon. Bundling it breaks it in a way that surfaces far from
 * the cause: webpack cannot statically extract its `require` of the compiled binding, the
 * CommonJS interop collapses, and `new Database(path)` ends up calling something that is
 * not the constructor — reported as `Cannot read properties of undefined`.
 *
 * `serverExternalPackages` alone is not enough here. It matches the app's own imports, but
 * the `require('better-sqlite3')` that matters is made *inside* `@sightline/db`, which
 * webpack bundles. The explicit externals entry is what actually keeps the addon on
 * Node's own require path.
 */
const config: NextConfig = {
  serverExternalPackages: ['better-sqlite3'],
  webpack: (webpackConfig, { isServer }) => {
    if (isServer) {
      webpackConfig.externals = [
        ...(Array.isArray(webpackConfig.externals) ? webpackConfig.externals : []),
        'better-sqlite3',
      ]
    }
    return webpackConfig
  },
}

export default config
