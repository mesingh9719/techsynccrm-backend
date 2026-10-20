/**
 * Registers every event subscriber. Imported once by the worker before the dispatcher starts.
 * Later modules add theirs here, e.g. `import './timeline.js'` (M10), `import './notifications.js'` (M11).
 */

import './usage.js'
import './scoring.js'
import './timeline.js'
import './notifications.js'

import './fileLinks.js'
