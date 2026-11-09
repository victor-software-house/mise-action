/**
 * Apply mise's `url_replacements` rules, read from `MISE_URL_REPLACEMENTS`, to
 * the action's own downloads, so mise itself comes from the same mirror that
 * mise later uses for tools.
 */

/** A URL to fetch, with any `user:password` taken out of it. */
export interface DownloadTarget {
  url: string
  credentials?: string
}

export interface UrlReplacementLog {
  warning(message: string): void
  setSecret(secret: string): void
}

/**
 * The rules in `MISE_URL_REPLACEMENTS`, in order, or undefined when it is
 * unset. A value that is not a JSON object of strings is ignored with a
 * warning, so a bad setting never blocks the download from GitHub.
 */
export function parseUrlReplacements(
  json: string | undefined,
  log: Pick<UrlReplacementLog, 'warning'>
): [string, string][] | undefined {
  if (!json) return undefined
  let rules: unknown
  try {
    rules = JSON.parse(json)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    log.warning(`Ignoring MISE_URL_REPLACEMENTS: not valid JSON (${reason})`)
    return undefined
  }
  if (
    typeof rules !== 'object' ||
    rules === null ||
    Array.isArray(rules) ||
    !Object.values(rules).every(v => typeof v === 'string')
  ) {
    log.warning(
      'Ignoring MISE_URL_REPLACEMENTS: expected a JSON object of string replacements'
    )
    return undefined
  }
  return Object.entries(rules as Record<string, string>)
}

/**
 * Rewrite `url` as mise does: rules apply in order, a plain key replaces every
 * occurrence anywhere in the URL, and the first rule that turns the URL into a
 * different valid URL wins. `regex:` rules are skipped; the action only
 * supports plain keys.
 */
export function replaceUrl(url: string, rules: [string, string][]): string {
  for (const [pattern, replacement] of rules) {
    if (pattern.startsWith('regex:') || !url.includes(pattern)) continue
    const replaced = url.split(pattern).join(replacement)
    if (replaced !== url && URL.canParse(replaced)) return replaced
  }
  return url
}

/** Take the userinfo out of `url`, so it never reaches a command line or log. */
export function downloadTarget(url: string): DownloadTarget {
  const parsed = new URL(url)
  if (!parsed.username && !parsed.password) return { url }
  const credentials = `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`
  parsed.username = ''
  parsed.password = ''
  return { url: parsed.toString(), credentials }
}

/** A curl config, read with `curl -K -`, that passes `credentials` on stdin. */
export function curlUserConfig(credentials: string): string {
  const quoted = credentials
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
  return `user = "${quoted}"\n`
}

/**
 * Fetch `url` through the first matching rule. When that fails, warn and fetch
 * the original URL instead, so a mirror outage never fails the run. `fetch`
 * gets `mirrored` so it can treat a missing file on the mirror as a failure.
 */
export async function withUrlReplacements<T>(
  url: string,
  rules: [string, string][] | undefined,
  fetch: (target: DownloadTarget, mirrored: boolean) => Promise<T>,
  log: UrlReplacementLog
): Promise<T> {
  const replaced = rules ? replaceUrl(url, rules) : url
  if (replaced === url) return fetch({ url }, false)
  const target = downloadTarget(replaced)
  try {
    if (target.credentials) {
      log.setSecret(target.credentials)
      // A token passed as the user name alone has an empty password.
      const sep = target.credentials.indexOf(':')
      log.setSecret(
        target.credentials.slice(sep + 1) || target.credentials.slice(0, sep)
      )
      // mise refuses the same downgrade.
      if (
        new URL(url).protocol === 'https:' &&
        new URL(target.url).protocol === 'http:'
      ) {
        throw new Error('refusing to send credentials over plain HTTP')
      }
    }
    return await fetch(target, true)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    log.warning(
      `Could not download ${target.url} through MISE_URL_REPLACEMENTS: ${reason}. Falling back to ${url}.`
    )
    return fetch({ url }, false)
  }
}
