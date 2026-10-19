/**
 * Readable device description for the sessions list and new-sign-in emails ("Chrome on Windows").
 * Deliberately simple — good enough for people to recognise their own devices.
 */
export function describeUserAgent(ua) {
  if (!ua) return { browser: 'Unknown browser', os: 'unknown device', label: 'Unknown device' }
  const browser =
    /Edg\//.test(ua) ? 'Edge'
    : /OPR\/|Opera/.test(ua) ? 'Opera'
    : /SamsungBrowser/.test(ua) ? 'Samsung Internet'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari'
    : /okhttp|Dart|axios|curl|node/i.test(ua) ? 'App'
    : 'Browser'
  const os =
    /Android/.test(ua) ? 'Android'
    : /iPhone|iPad|iPod/.test(ua) ? 'iOS'
    : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X|Macintosh/.test(ua) ? 'macOS'
    : /CrOS/.test(ua) ? 'ChromeOS'
    : /Linux/.test(ua) ? 'Linux'
    : 'unknown device'
  return { browser, os, label: `${browser} on ${os}` }
}

/** IPv4 /24 or IPv6 /64 prefix — "the same network" for new-device detection. */
export function networkPrefix(ip) {
  if (!ip) return null
  const v4 = ip.replace(/^::ffff:/, '')
  if (/^\d+\.\d+\.\d+\.\d+$/.test(v4)) return v4.split('.').slice(0, 3).join('.')
  return ip.split(':').slice(0, 4).join(':')
}
