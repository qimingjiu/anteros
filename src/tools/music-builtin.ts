/** Music-only extraction of twig-mnemosyne/mcp-gateway/src/builtin.ts.
 * Preserves NetEase weapi, ccMixter public API and Jamendo search without
 * importing the unrelated gateway or requiring its Windows source path.
 * Jamendo credentials come from JAMENDO_CLIENT_ID, inherited by MCP stdio.
 */
import { createCipheriv, randomBytes } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import type { ToolParamSchema } from '../types.js'

export interface MusicBuiltin {
  tools: { name: string; description: string; inputSchema: ToolParamSchema }[]
  call(tool: string, args: Record<string, unknown>): Promise<string>
}

export interface MusicBuiltinOptions {
  fetch?: typeof fetch
  getJson?: (url: string, timeoutMs: number) => Promise<unknown>
  jamendoClientId?: string
}

export interface MusicSong {
  id: number
  title: string
  artist: string
  pageUrl: string
  playUrl: string
  /** 来源平台标识（用于多源搜索区分） */
  source?: string
  /** Creative Commons license URL when provided by the music platform. */
  licenseUrl?: string
}
/** Compact, bounded legacy envelope consumed by the caller. Candidate URLs
 * are returned as supplied by the source; availability is not guaranteed. */
export function musicEnvelope(action: 'search' | 'play', songs: MusicSong[]): string {
  return JSON.stringify({ status: 'music', action, songs: songs.slice(0, 10) })
}

function strArg(args: Record<string, unknown>, key: string, fallback = ''): string {
  const v = args[key]
  return typeof v === 'string' && v ? v : fallback
}

function numArg(args: Record<string, unknown>, key: string, fallback: number): number {
  const v = args[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

export function createMusicBuiltin(options: MusicBuiltinOptions = {}): MusicBuiltin {
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) mnemosyne-gateway/0.2'
  const fetcher = options.fetch ?? fetch
  async function http(url: string, init: RequestInit = {}, timeoutMs = 20_000): Promise<Response> {
    const headers = { 'User-Agent': UA, ...(init.headers ?? {}) }
    return fetcher(url, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) })
  }

  interface NeteaseSong {
    id: number
    name: string
    artists?: { name: string }[]
  }

  // weapi 加密（公开搜索需要；cloudsearch 端点已加风控返回 50000005，旧 search/get/web 仍可用）
  const NE_MODULUS = '00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7'
  const NE_NONCE = '0CoJUm6Qyw8W8jud'

  function neAes(text: string, key: string): string {
    const cipher = createCipheriv('aes-128-cbc', Buffer.from(key), Buffer.from('0102030405060708'))
    return cipher.update(text, 'utf8', 'base64') + cipher.final('base64')
  }

  function neRsa(text: string): string {
    const reversed = Buffer.from(text.split('').reverse().join(''), 'utf8')
    const bi = BigInt(`0x${reversed.toString('hex')}`)
    return (bi ** 0x10001n % BigInt(`0x${NE_MODULUS}`)).toString(16).padStart(256, '0')
  }

  function neWeapi(payload: Record<string, string>): string {
    const secKey = randomBytes(8).toString('hex') // 16 个十六进制字符
    return new URLSearchParams({
      params: neAes(neAes(JSON.stringify(payload), NE_NONCE), secKey),
      encSecKey: neRsa(secKey),
    }).toString()
  }

  async function neteaseSearch(query: string, limit: number): Promise<MusicSong[]> {
    const res = await http('https://music.163.com/weapi/search/get/web', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: 'https://music.163.com/',
        Cookie: 'os=pc',
        // 网易 weapi 会检测 X-Real-IP 判断国内 IP；海外机房（Zeabur HK）不加则返回空
        'X-Real-IP': '223.5.5.5',
      },
      body: neWeapi({ s: query, type: '1', offset: '0', limit: String(limit), csrf_token: '' }),
    })
    if (!res.ok) throw new Error(`netease ${res.status}`)
    const data = (await res.json()) as { code?: number; result?: { songs?: NeteaseSong[] } }
    if (data.code !== undefined && data.code !== 200) throw new Error(`netease code ${data.code}`)
    const songs = data.result?.songs ?? []
    return songs.slice(0, limit).map(s => ({
      id: s.id,
      title: s.name,
      artist: (s.artists ?? []).map(a => a.name).join('/') || 'unknown',
      pageUrl: `https://music.163.com/song?id=${s.id}`,
      playUrl: `https://music.163.com/song/media/outer/url?id=${s.id}.mp3`,
      source: 'netease',
    }))
  }

  // ── ccMixter：Creative Commons 音乐社区（公开 API，无需 key）──────────────────
  interface CcMixterSong {
    upload_id: number
    upload_name: string
    user_name: string
    user_real_name?: string
    file_page_url: string
    files?: { file_nicname: string; download_url: string; file_format_info?: { 'media-type': string } }[]
  }

  /** ccMixter 用原生 http（node:http request）避免 undici HeadersOverflowError。
   *  ccMixter 返回大量 Set-Cookie，需把 maxHeaderSize 扩到 256KB。 */
  function httpGetJson<T>(url: string, timeoutMs = 15_000): Promise<T> {
    if (options.getJson) return options.getJson(url, timeoutMs) as Promise<T>
    return new Promise((resolve, reject) => {
      const req = httpRequest(url, { headers: { 'User-Agent': UA }, maxHeaderSize: 256_000 }, (res) => {
        let raw = ''
        res.on('data', chunk => { raw += chunk })
        res.on('end', () => {
          try { resolve(JSON.parse(raw) as T) } catch (e) { reject(new Error(`ccmixter json parse: ${e}`)) }
        })
      })
      req.on('error', reject)
      req.on('timeout', () => { req.destroy(); reject(new Error('ccmixter timeout')) })
      req.setTimeout(timeoutMs)
      req.end()
    })
  }

  async function ccMixterSearch(query: string, limit: number): Promise<MusicSong[]> {
    const data = await httpGetJson<CcMixterSong[]>(
      `http://ccmixter.org/api/query?search=${encodeURIComponent(query)}&limit=${limit}&format=json`,
    )
    if (!Array.isArray(data)) throw new Error('ccmixter invalid response')
    return data.slice(0, limit).map(s => {
      const mp3File = s.files?.find(f => f.file_nicname === 'mp3' || f.file_format_info?.['media-type'] === 'audio')
      const downloadUrl = mp3File?.download_url ?? s.files?.[0]?.download_url ?? ''
      return {
        id: s.upload_id,
        title: s.upload_name,
        artist: s.user_real_name || s.user_name || 'unknown',
        pageUrl: s.file_page_url,
        playUrl: downloadUrl,
        source: 'ccmixter',
      }
    })
  }

  // ── Jamendo：Creative Commons 音乐库（需 client_id；用户已提供）────────────────
  const JAMENDO_CLIENT_ID = options.jamendoClientId ?? process.env.JAMENDO_CLIENT_ID ?? ''

  interface JamendoTrack {
    id: string
    name: string
    artist_name: string
    shareurl: string
    audio: string
    audiodownload: string
    license_ccurl?: string
  }

  async function jamendoSearch(query: string, limit: number): Promise<MusicSong[]> {
    if (!JAMENDO_CLIENT_ID) throw new Error('jamendo client_id not configured')
    const res = await http(
      `https://api.jamendo.com/v3.0/tracks/?client_id=${JAMENDO_CLIENT_ID}&format=json&search=${encodeURIComponent(query)}&limit=${limit}`,
      {},
      15_000,
    )
    if (!res.ok) throw new Error(`jamendo ${res.status}`)
    const data = (await res.json()) as { headers?: { status?: string }; results?: JamendoTrack[] }
    if (data.headers?.status !== 'success') throw new Error(`jamendo api error: ${data.headers?.status}`)
    const tracks = data.results ?? []
    return tracks.slice(0, limit).map(t => ({
      id: parseInt(t.id, 10) || 0,
      title: t.name,
      artist: t.artist_name || 'unknown',
      pageUrl: t.shareurl,
      playUrl: t.audio || t.audiodownload,
      source: 'jamendo',
      ...(t.license_ccurl ? { licenseUrl: t.license_ccurl } : {}),
    }))
  }


  const server: MusicBuiltin = {
    tools: [
      {
        name: 'search',
        description: 'Search multiple music platforms (NetEase + ccMixter + Jamendo), returns candidates with page/play URLs',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', minLength: 1, maxLength: 300, description: 'Song / artist keywords' },
            limit: { type: 'integer', minimum: 1, maximum: 10, default: 5, description: 'Max results per platform (default 5, cap 10 total)' },
          },
          required: ['query'],
        },
      },
      {
        name: 'play',
        description: 'Find one song candidate with page/play URLs. Does not itself send or play audio; NetEase outer/url playback is not guaranteed.',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string', minLength: 1, maxLength: 300, description: 'Song / artist keywords' } },
          required: ['query'],
        },
      },
    ],
    call: async (tool, args) => {
      const query = strArg(args, 'query').trim()
      if (!query) throw new Error('query required')
      if (query.length > 300) throw new Error('query too long (maximum 300 characters)')
      if (tool === 'search') {
        const limit = Math.max(1, Math.min(Math.floor(numArg(args, 'limit', 5)), 10))
        // 并行搜索三源：网易云 + ccMixter + Jamendo
        const [netease, ccmixter, jamendo] = await Promise.allSettled([
          neteaseSearch(query, limit),
          ccMixterSearch(query, limit),
          jamendoSearch(query, limit),
        ])
        const songs: MusicSong[] = []
        if (netease.status === 'fulfilled') songs.push(...netease.value)
        if (ccmixter.status === 'fulfilled') songs.push(...ccmixter.value)
        if (jamendo.status === 'fulfilled') songs.push(...jamendo.value)
        if (songs.length === 0) {
          const errs = [netease, ccmixter, jamendo]
            .filter(r => r.status === 'rejected')
            .map(r => (r as PromiseRejectedResult).reason)
          throw new Error(`all sources failed: ${errs.map(e => e instanceof Error ? e.message : String(e)).join('; ')}`)
        }
        return musicEnvelope('search', songs)
      }
      if (tool === 'play') {
        // play 优先网易云 → Jamendo → ccMixter（外链稳定性递减）
        try {
          const songs = await neteaseSearch(query, 1)
          if (songs.length === 0) throw new Error('netease no results')
          return musicEnvelope('play', songs)
        } catch {
          try {
            const songs = await jamendoSearch(query, 1)
            if (songs.length === 0) throw new Error('jamendo no results')
            return musicEnvelope('play', songs)
          } catch {
            const songs = await ccMixterSearch(query, 1)
            if (songs.length === 0) throw new Error('ccmixter no results')
            return musicEnvelope('play', songs)
          }
        }
      }
      throw new Error(`unknown builtin tool: music/${tool}`)
    },

  }
  return server
}