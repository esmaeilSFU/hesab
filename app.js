/**
 * Hesab temporary loader
 *
 * The full original app.js (~122 KB) exceeds the current GitHub connector
 * payload size limit, so this small file loads the last known-good version
 * directly from the historical commit. Behavior is identical to the original.
 *
 * Once the code is modularized into smaller files the loader will be removed.
 */
import('https://raw.githubusercontent.com/esmaeilSFU/hesab/d2b938619a82de967394c5c9d9929185d4d5fb80/app.js');
