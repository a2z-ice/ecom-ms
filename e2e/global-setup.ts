import * as fs from 'fs'

/**
 * Global setup: ensures the screenshots directory exists before any test runs.
 */
export default function globalSetup() {
  if (!fs.existsSync('screenshots')) {
    fs.mkdirSync('screenshots', { recursive: true })
  }
}
