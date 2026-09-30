/**
 * Skill market browser (v0.8.17): aggregate search across SkillHub + ClawHub,
 * an in-panel detail view with the SKILL.md body, and one-click install into
 * `$DSH_HOME/skills` (reusing the market installer's safe ZIP extraction).
 * Extracted as its own component so SkillsSection keeps only the installed
 * catalog management.
 */
import { useCallback, useState } from 'react'
import { Button, Input, MarkdownText, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  WorkbenchMarketDetail, WorkbenchMarketInstallRequest, WorkbenchMarketInstallResult,
  WorkbenchMarketItem,
} from '../../shared.ts'
import css from '../WorkbenchPanel.module.css'

/** Reference-stable labels for MarkdownText (identity churn busts its cache). */
const MARKDOWN_LABELS = {
  code: { copyLabel: '复制', copiedLabel: '已复制' },
  footnotes: '脚注',
} as const

type MarketSearchFn = (keyword: string, source?: string) => Promise<{ ok: boolean; items: WorkbenchMarketItem[]; errors: string[] }>
type MarketDetailFn = (source: string, slug: string, ownerHandle?: string) => Promise<WorkbenchMarketDetail>
type MarketInstallFn = (request: WorkbenchMarketInstallRequest) => Promise<WorkbenchMarketInstallResult>
/** Slim install target — both result cards and the detail modal produce one. */
type InstallTarget = { source: 'skillhub' | 'clawhub'; slug: string; ownerHandle?: string }

const SOURCE_LABEL: Record<string, string> = { skillhub: 'SkillHub', clawhub: 'ClawHub' }

function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

export function SkillsMarket(props: {
  marketSearch: MarketSearchFn
  marketDetail: MarketDetailFn
  marketInstall: MarketInstallFn
  /** Refresh the installed catalog after a successful install. */
  onInstalled: () => void
}) {
  const { marketSearch, marketDetail, marketInstall, onInstalled } = props
  const [keyword, setKeyword] = useState('')
  const [source, setSource] = useState<'all' | 'skillhub' | 'clawhub'>('all')
  const [items, setItems] = useState<WorkbenchMarketItem[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  /** The entry whose detail is on screen (carries ownerHandle for install). */
  const [detailEntry, setDetailEntry] = useState<WorkbenchMarketItem | null>(null)
  const [detail, setDetail] = useState<WorkbenchMarketDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [installingSlug, setInstallingSlug] = useState<string | null>(null)
  const [installNote, setInstallNote] = useState<string | null>(null)

  const runSearch = useCallback(async (nextKeyword: string, nextSource: 'all' | 'skillhub' | 'clawhub'): Promise<void> => {
    setSearching(true)
    setSearchError(null)
    try {
      const result = await marketSearch(nextKeyword, nextSource === 'all' ? undefined : nextSource)
      setItems(result.items)
      if (result.errors.length > 0) {
        setSearchError(`部分数据源失败：${result.errors.join('；')}`)
      }
    } catch (error) {
      setSearchError(error instanceof Error ? error.message : String(error))
      setItems([])
    } finally {
      setSearching(false)
    }
  }, [marketSearch])

  const openDetail = useCallback(async (item: WorkbenchMarketItem): Promise<void> => {
    setDetailLoading(true)
    setDetail(null)
    setDetailEntry(item)
    try {
      setDetail(await marketDetail(item.source, item.slug, item.ownerHandle !== '' ? item.ownerHandle : undefined))
    } catch (error) {
      setDetail({
        ok: true, source: item.source, slug: item.slug, name: item.displayName,
        summary: item.summary, author: item.author, downloads: item.downloads,
        installs: item.installs, stars: item.stars, verified: item.verified,
        version: item.version,
        readme: `详情加载失败：${error instanceof Error ? error.message : String(error)}`,
      })
    } finally {
      setDetailLoading(false)
    }
  }, [marketDetail])

  const install = useCallback(async (target: InstallTarget): Promise<void> => {
    setInstallingSlug(target.slug)
    setInstallNote(null)
    try {
      const result = await marketInstall({
        source: target.source, slug: target.slug,
        ...(target.ownerHandle !== undefined && target.ownerHandle !== '' ? { ownerHandle: target.ownerHandle } : {}),
      })
      if (!result.ok) {
        setInstallNote(`安装失败：${result.error ?? '未知错误'}`)
        return
      }
      setInstallNote(`已安装「${result.name ?? target.slug}」，目录：${result.dir}`)
      onInstalled()
    } catch (error) {
      setInstallNote(`安装失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setInstallingSlug(null)
    }
  }, [marketInstall, onInstalled])

  return (
    <div className={css.marketPane}>
      <form
        className={css.marketSearchRow}
        onSubmit={event => {
          event.preventDefault()
          void runSearch(keyword.trim(), source)
        }}
      >
        <Input
          placeholder="搜索技能市场（中英文均可）…"
          value={keyword}
          aria-label="搜索技能市场"
          onChange={event => { setKeyword(event.target.value) }}
        />
        <select
          className={css.kindSelect}
          value={source}
          aria-label="数据源"
          onChange={event => { setSource(event.target.value as 'all' | 'skillhub' | 'clawhub') }}
        >
          <option value="all">全部来源</option>
          <option value="skillhub">SkillHub（国内快）</option>
          <option value="clawhub">ClawHub</option>
        </select>
        <Button size="sm" variant="primary" type="submit" disabled={searching}>
          {searching ? '搜索中…' : '搜索'}
        </Button>
      </form>

      {searchError !== null && <p className={css.errorBanner} role="alert">{searchError}</p>}
      {installNote !== null && <p className={css.checkMeta} role="status">{installNote}</p>}

      {items !== null && items.length === 0 && !searching && (
        <p className={css.hint}>没有匹配的技能，换个关键词试试。</p>
      )}
      {items !== null && items.length > 0 && (
        <ul className={css.marketList}>
          {items.map(item => {
            const busy = installingSlug === item.slug
            return (
              <li key={`${item.source}:${item.slug}`} className={css.marketItem}>
                <div className={css.marketItemHead}>
                  <span className={css.marketName}>{item.displayName !== '' ? item.displayName : item.name}</span>
                  <span className={css.marketSource}>{SOURCE_LABEL[item.source] ?? item.source}</span>
                  {item.verified && <span className={css.marketVerified} title="已认证作者">✓</span>}
                  {item.installed === true && <span className={css.badge}>已装</span>}
                </div>
                {item.summary !== '' && <p className={css.marketSummary}>{item.summary}</p>}
                <div className={css.marketMeta}>
                  {item.author !== '' && <span>{item.author}</span>}
                  <span>↓ {formatCount(item.downloads)}</span>
                  {item.stars > 0 && <span>★ {formatCount(item.stars)}</span>}
                  <span className={css.spacer} />
                  <Button size="sm" variant="outline" onClick={() => { void openDetail(item) }} disabled={detailLoading}>详情</Button>
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => { void install(item) }}
                    disabled={busy || item.installed === true}
                    title={item.installed === true ? '同名技能已存在于 $DSH_HOME/skills' : '下载并安装到 $DSH_HOME/skills'}
                  >
                    {busy ? '安装中…' : item.installed === true ? '已装' : '安装'}
                  </Button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
      {items === null && !searching && (
        <p className={css.hint}>
          聚合 SkillHub（腾讯云国内镜像）与 ClawHub 两个技能社区：搜索后可查看说明并一键安装到本地。
        </p>
      )}

      <Modal
        open={detail !== null || detailLoading}
        onClose={() => { setDetail(null); setDetailLoading(false) }}
        title={detail?.displayName ?? detail?.name ?? '技能详情'}
        closeLabel="关闭"
        contentClassName={css.marketDetailBody}
        footer={detail !== null && (
          <>
            <span className={css.checkMeta}>
              {detail.author !== '' ? `${detail.author} · ` : ''}
              ↓ {formatCount(detail.downloads)}
              {detail.stars > 0 ? ` · ★ ${formatCount(detail.stars)}` : ''}
              {detail.version !== '' ? ` · v${detail.version}` : ''}
            </span>
            <span className={css.spacer} />
            <Button
              size="sm"
              variant="primary"
              data-modal-autofocus
              disabled={installingSlug !== null}
              onClick={() => {
                void install({
                  source: detail.source, slug: detail.slug,
                  ...(detailEntry !== null && detailEntry.ownerHandle !== '' ? { ownerHandle: detailEntry.ownerHandle } : {}),
                }).then(() => { onInstalled() })
              }}
            >
              {installingSlug !== null ? '安装中…' : '安装'}
            </Button>
          </>
        )}
      >
        {detailLoading || detail === null ? (
          <p className={css.hint}>正在加载详情…</p>
        ) : (
          <div className={css.marketDetail}>
            {detail.summary !== '' && <p className={css.marketSummary}>{detail.summary}</p>}
            {detail.readme !== ''
              ? <MarkdownText text={detail.readme} labels={MARKDOWN_LABELS} variant="compact" />
              : <p className={css.hint}>该技能没有可展示的说明正文。</p>}
          </div>
        )}
      </Modal>
    </div>
  )
}
