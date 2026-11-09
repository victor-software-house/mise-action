import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import http from 'node:http'
import test from 'node:test'
import {
  curlUserConfig,
  downloadTarget,
  parseUrlReplacements,
  replaceUrl,
  withUrlReplacements
} from '../src/url-replacements.ts'

const asset =
  'https://github.com/jdx/mise/releases/download/v2026.1.0/mise-v2026.1.0-linux-x64.tar.zst'

function recorder() {
  const log = { warnings: [], secrets: [] }
  log.warning = message => log.warnings.push(message)
  log.setSecret = secret => log.secrets.push(secret)
  return log
}

test('reads rules from a JSON object in order', () => {
  const log = recorder()
  assert.deepEqual(
    parseUrlReplacements('{"https://github.com/":"https://a/","x":"y"}', log),
    [
      ['https://github.com/', 'https://a/'],
      ['x', 'y']
    ]
  )
  assert.deepEqual(log.warnings, [])
})

test('ignores an unset value, and warns about one that is not an object of strings', () => {
  const log = recorder()
  assert.equal(parseUrlReplacements(undefined, log), undefined)
  assert.equal(parseUrlReplacements('', log), undefined)
  assert.deepEqual(log.warnings, [])
  for (const bad of ['{', '[]', '"x"', 'null', '{"a":1}']) {
    assert.equal(parseUrlReplacements(bad, log), undefined, bad)
  }
  assert.equal(log.warnings.length, 5)
})

test('replaces a plain key and keeps the rest of the URL', () => {
  assert.equal(
    replaceUrl(asset, [['https://github.com/', 'https://mirror.example/gh/']]),
    'https://mirror.example/gh/jdx/mise/releases/download/v2026.1.0/mise-v2026.1.0-linux-x64.tar.zst'
  )
})

test('replaces every occurrence of a plain key, as mise does', () => {
  assert.equal(
    replaceUrl('https://h/v1/a/v1', [['v1', 'v2']]),
    'https://h/v2/a/v2'
  )
})

test('uses the first rule that changes the URL', () => {
  assert.equal(
    replaceUrl(asset, [
      ['https://example.org/', 'https://never/'],
      ['https://github.com/jdx/', 'https://first/'],
      ['https://github.com/', 'https://second/']
    ]),
    asset.replace('https://github.com/jdx/', 'https://first/')
  )
})

test('skips a rule that leaves the URL unchanged or makes it invalid', () => {
  assert.equal(
    replaceUrl(asset, [
      ['https://github.com/', 'https://github.com/'],
      ['https://', 'not a url '],
      ['https://github.com/', 'https://mirror/']
    ]),
    asset.replace('https://github.com/', 'https://mirror/')
  )
})

test('skips regex rules', () => {
  assert.equal(replaceUrl(asset, [['regex:^https://github\\.com/', 'https://x/']]), asset)
})

test('takes credentials out of the URL', () => {
  assert.deepEqual(downloadTarget('https://ci:p%40ss@mirror.example/a'), {
    url: 'https://mirror.example/a',
    credentials: 'ci:p@ss'
  })
  assert.deepEqual(downloadTarget('https://mirror.example/a'), {
    url: 'https://mirror.example/a'
  })
})

test('curl reads the credentials from its stdin config', async t => {
  const credentials = 'ci:t"o\\k:en'
  const server = http.createServer((req, res) => {
    res.end(req.headers.authorization ?? 'none')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const url = `http://127.0.0.1:${server.address().port}/`
  const got = await new Promise((resolve, reject) => {
    const child = execFile('curl', ['-K', '-', '-fsS', url], (err, stdout) =>
      err ? reject(err) : resolve(stdout)
    )
    child.stdin.end(curlUserConfig(credentials))
  })
  assert.equal(got, `Basic ${Buffer.from(credentials).toString('base64')}`)
})

test('fetches the original URL when no rule matches', async () => {
  const log = recorder()
  const calls = []
  const got = await withUrlReplacements(
    asset,
    [['https://example.org/', 'https://mirror/']],
    async (target, mirrored) => {
      calls.push([target, mirrored])
      return 'ok'
    },
    log
  )
  assert.equal(got, 'ok')
  assert.deepEqual(calls, [[{ url: asset }, false]])
})

test('fetches the mirror with masked credentials kept out of the URL', async () => {
  const log = recorder()
  const calls = []
  await withUrlReplacements(
    asset,
    [['https://github.com/', 'https://ci:secret@mirror.example/']],
    async (target, mirrored) => {
      calls.push([target, mirrored])
    },
    log
  )
  assert.deepEqual(calls, [
    [
      {
        url: asset.replace('https://github.com/', 'https://mirror.example/'),
        credentials: 'ci:secret'
      },
      true
    ]
  ])
  assert.deepEqual(log.secrets, ['ci:secret', 'secret'])
  assert.deepEqual(log.warnings, [])
})

test('falls back to the original URL with a warning when the mirror fails', async () => {
  const log = recorder()
  const calls = []
  const got = await withUrlReplacements(
    asset,
    [['https://github.com/', 'https://ci:secret@mirror.example/']],
    async (target, mirrored) => {
      calls.push(target.url)
      if (mirrored) throw new Error('HTTP 503')
      return 'from github'
    },
    log
  )
  assert.equal(got, 'from github')
  assert.equal(calls.length, 2)
  assert.equal(calls[1], asset)
  assert.equal(log.warnings.length, 1)
  assert.match(log.warnings[0], /HTTP 503/)
  assert.doesNotMatch(log.warnings[0], /secret/)
})

test('refuses to send credentials over plain HTTP', async () => {
  const log = recorder()
  const calls = []
  await withUrlReplacements(
    asset,
    [['https://github.com/', 'http://ci:secret@mirror.example/']],
    async (target, mirrored) => {
      calls.push(mirrored)
    },
    log
  )
  assert.deepEqual(calls, [false])
  assert.match(log.warnings[0], /plain HTTP/)
})
